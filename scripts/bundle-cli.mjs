import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = path.join(root, "directus-extension-backport/node_modules/esbuild/bin/esbuild");
const outfile = path.join(root, "directus-extension-backport/cli.mjs");
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
