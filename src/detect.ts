import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectusInstall } from "./types.js";

const CANDIDATES = [
	"node_modules",
	"directus-node_modules",
	path.join("directus", "node_modules"),
];

function uniqueExisting(paths: Array<string | undefined | null>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of paths) {
		if (!raw) continue;
		const resolved = path.resolve(raw);
		if (seen.has(resolved)) continue;
		try {
			if (!fs.existsSync(resolved)) continue;
		} catch {
			continue;
		}
		seen.add(resolved);
		out.push(resolved);
	}
	return out;
}

function readVersion(pkgFile: string): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { name?: string; version?: string };
		if (pkg.name === "directus" && typeof pkg.version === "string") return pkg.version;
		return null;
	} catch {
		return null;
	}
}

function findDirectusPackage(nodeModules: string): string | null {
	const direct = path.join(nodeModules, "directus", "package.json");
	if (fs.existsSync(direct)) return direct;

	const pnpm = path.join(nodeModules, ".pnpm");
	if (!fs.existsSync(pnpm)) return null;

	for (const entry of fs.readdirSync(pnpm)) {
		if (!entry.startsWith("directus@")) continue;
		const nested = path.join(pnpm, entry, "node_modules", "directus", "package.json");
		if (fs.existsSync(nested)) return nested;
	}
	return null;
}

function nodeModulesAt(root: string): string | null {
	for (const rel of CANDIDATES) {
		const dir = path.resolve(root, rel);
		if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
			if (findDirectusPackage(dir)) return dir;
		}
	}
	if (findDirectusPackage(root)) return root;
	return null;
}

function installAt(dir: string): DirectusInstall | null {
	const pkg = path.join(dir, "package.json");
	const nestedModules = path.join(dir, "node_modules");

	// Prefer node_modules/directus (real app). Project scaffolds often use
	// { "name": "directus", "version": "1.0.0", "dependencies": { "directus": "11.x" } }.
	const nodeModules = nodeModulesAt(dir);
	if (nodeModules) {
		const directusPackage = findDirectusPackage(nodeModules);
		if (directusPackage) {
			const version = readVersion(directusPackage);
			if (version) {
				return {
					root: dir,
					nodeModules,
					version,
					directusPackage,
				};
			}
		}
	}

	const rootVersion = readVersion(pkg);
	if (rootVersion && fs.existsSync(nestedModules) && fs.statSync(nestedModules).isDirectory()) {
		return {
			root: dir,
			nodeModules: nestedModules,
			version: rootVersion,
			directusPackage: pkg,
		};
	}

	return null;
}

function walkFrom(start: string): DirectusInstall | null {
	let dir = path.resolve(start);
	while (true) {
		const found = installAt(dir);
		if (found) return found;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function discoveryStarts(): string[] {
	let here: string | undefined;
	try {
		here = path.dirname(fileURLToPath(import.meta.url));
	} catch {
		here = undefined;
	}
	return uniqueExisting([
		process.env.DIRECTUS_BACKPORT_ROOT,
		process.cwd(),
		here,
		"/opt/node/directus",
		"/directus",
	]);
}

function notFound(from: string): Error {
	return new Error(
		`No Directus install found from ${from}. Run this from the Directus folder (or inside the container). --root is only needed when the install is somewhere else.`,
	);
}

/**
 * Find a Directus install.
 * With `start` (including `--root`), only that path and its parents are searched.
 * With no argument, cwd, DIRECTUS_BACKPORT_ROOT, this CLI's folder, and `/directus` are tried.
 */
export function detectInstall(start?: string): DirectusInstall {
	if (start) {
		const found = walkFrom(start);
		if (found) return found;
		throw notFound(start);
	}

	const starts = discoveryStarts();
	for (const dir of starts) {
		const found = walkFrom(dir);
		if (found) return found;
	}

	throw notFound(starts.join(", ") || process.cwd());
}

/**
 * Resolve a catalog path like `@directus/api/dist/foo.js` through pnpm symlinks.
 */
export function resolveNodeFile(nodeModules: string, rel: string): string {
	const direct = path.join(nodeModules, rel);
	if (fs.existsSync(direct)) return fs.realpathSync(direct);

	const parts = rel.split(/[/\\]/);
	const scoped = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
	if (!scoped) throw new Error(`Invalid patch path: ${rel}`);

	const pkgJson = path.join(nodeModules, scoped, "package.json");
	if (fs.existsSync(pkgJson)) {
		const pkgRoot = fs.realpathSync(path.dirname(pkgJson));
		const rest = rel.slice(scoped.length).replace(/^[/\\]/, "");
		const file = path.join(pkgRoot, rest);
		if (fs.existsSync(file)) return fs.realpathSync(file);
	}

	throw new Error(`Could not resolve ${rel} under ${nodeModules}`);
}
