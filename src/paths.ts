import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAMES = new Set(["directus-backport", "directus-extension-backport"]);

function readPackageName(dir: string): string | null {
	const file = path.join(dir, "package.json");
	if (!fs.existsSync(file)) return null;
	try {
		const name = (JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string }).name;
		return typeof name === "string" ? name : null;
	} catch {
		return null;
	}
}

/** True when this directory is the CLI package or the Studio extension root. */
export function isPackageRoot(dir: string): boolean {
	const name = readPackageName(dir);
	if (name && PACKAGE_NAMES.has(name)) return true;
	if (fs.existsSync(path.join(dir, "catalog", "advisories.yml"))) return true;
	if (fs.existsSync(path.join(dir, "catalog-remote", "advisories.yml"))) return true;
	// Marketplace / zip layout: dist/ holds api + cli (catalog optional)
	if (
		fs.existsSync(path.join(dir, "dist", "api.js")) &&
		(fs.existsSync(path.join(dir, "dist", "cli.mjs")) || fs.existsSync(path.join(dir, "cli.mjs")))
	) {
		return true;
	}
	return false;
}

/**
 * Walk up from the caller (CLI source, bundled cli.mjs, or extension dist/api.js)
 * to the package that owns catalog/, catalog-remote/, and cli.mjs.
 * Does not require a locally shipped catalog — GitHub fetch can populate catalog-remote/.
 */
export function findPackageRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
	let dir = start;
	while (true) {
		if (isPackageRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"Could not find the directus-backport package root (looked for package.json name, cli.mjs, or catalog/). " +
			"Install the extension with package.json, dist/, and cli.mjs. Catalog comes from the CLI repo bundle " +
			"or an opt-in GitHub fetch (Check for Updates / catalog --refresh).",
	);
}

export function dataDir(nodeModules: string): string {
	return path.join(nodeModules, "..", ".directus-backport");
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
	if (!fs.existsSync(file)) return fallback;
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
