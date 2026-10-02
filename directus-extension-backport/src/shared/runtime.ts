import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstall } from "../../../src/detect.js";
import { resolveCatalogDir } from "../../../src/catalog-source.js";

const EXT_NAME = "directus-extension-backport";

export function installFromEnv() {
	return detectInstall(process.env.DIRECTUS_BACKPORT_ROOT || undefined);
}

function isExtRoot(root: string): boolean {
	const pkg = path.join(root, "package.json");
	if (!fs.existsSync(pkg)) return false;
	try {
		const name = (JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string }).name;
		return name === EXT_NAME;
	} catch {
		return false;
	}
}

/**
 * Folder that holds package.json, dist/, cli.mjs.
 * Order: env → next to running api.js → <Directus root>/extensions/… → cwd guesses.
 */
export function extensionPackageRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
	const env = (process.env.DIRECTUS_BACKPORT_EXTENSION || "").trim();
	if (env && isExtRoot(env)) return path.resolve(env);

	const candidates: string[] = [];

	if (path.basename(start) === "dist") candidates.push(path.dirname(start));
	candidates.push(start);

	let dir = start;
	for (let i = 0; i < 10; i++) {
		candidates.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	try {
		const install = detectInstall(process.env.DIRECTUS_BACKPORT_ROOT || undefined);
		candidates.push(path.join(install.root, "extensions", EXT_NAME));
		// node_modules-style layouts sometimes keep extensions beside the package root
		candidates.push(path.join(path.dirname(install.root), "extensions", EXT_NAME));
		candidates.push(path.join(install.nodeModules, "..", "extensions", EXT_NAME));
	} catch {
		/* no install detected yet */
	}

	for (const base of [process.cwd(), "/opt/node/directus", "/directus"]) {
		candidates.push(path.join(base, "extensions", EXT_NAME));
	}

	const seen = new Set<string>();
	for (const candidate of candidates) {
		const root = path.resolve(candidate);
		if (seen.has(root)) continue;
		seen.add(root);
		if (isExtRoot(root)) return root;
	}

	for (const candidate of seen) {
		if (
			fs.existsSync(path.join(candidate, "dist", "api.js")) &&
			(fs.existsSync(path.join(candidate, "dist", "cli.mjs")) ||
				fs.existsSync(path.join(candidate, "cli.mjs")))
		) {
			return candidate;
		}
	}

	throw new Error(
		`Could not locate ${EXT_NAME}. Expected something like ` +
			`/opt/node/directus/extensions/${EXT_NAME} with package.json + dist/ + cli.mjs. ` +
			`Set DIRECTUS_BACKPORT_EXTENSION to that folder.`,
	);
}

/** Pin catalog + CLI paths to this extension folder for the rest of the process. */
export function pinExtensionRoot(): string {
	const root = extensionPackageRoot();
	process.env.DIRECTUS_BACKPORT_EXTENSION = root;
	return root;
}

export function catalogRoot(): string | undefined {
	const root = (() => {
		try {
			return pinExtensionRoot();
		} catch {
			return null;
		}
	})();

	if (root) {
		const remote = path.join(root, "catalog-remote", "advisories.yml");
		if (fs.existsSync(remote)) return path.join(root, "catalog-remote");
		const bundled = path.join(root, "catalog", "advisories.yml");
		if (fs.existsSync(bundled)) return path.join(root, "catalog");
	}

	try {
		return resolveCatalogDir();
	} catch {
		return undefined;
	}
}

export function autoReapplyEnabled(): boolean {
	const value = (process.env.DIRECTUS_BACKPORT_AUTO || "1").trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}
