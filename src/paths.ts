import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findPackageRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
	let dir = start;
	while (true) {
		const catalog = path.join(dir, "catalog", "advisories.yml");
		if (fs.existsSync(catalog)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not find catalog/advisories.yml (package root).");
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
