import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "directus-extension-backport");
const esbuild = path.join(ext, "node_modules/esbuild/bin/esbuild");
const distDir = path.join(ext, "dist");
fs.mkdirSync(distDir, { recursive: true });
const outfile = path.join(distDir, "cli.mjs");
const result = spawnSync(
	esbuild,
	[
		path.join(root, "src/cli.ts"),
		"--bundle",
		"--platform=node",
		"--format=esm",
		"--banner:js=import { createRequire as __backportCreateRequire } from \"node:module\"; const require = __backportCreateRequire(import.meta.url);",
		`--outfile=${outfile}`,
	],
	{ stdio: "inherit" },
);
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
console.log("bundled", outfile);
