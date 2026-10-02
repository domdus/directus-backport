#!/usr/bin/env node
/**
 * Marketplace / deploy zip for …/extensions/directus-extension-backport.
 *
 * Default: package.json + dist/ (api.js, app.js, cli.mjs, rollback.mjs) — no catalog/.
 * INCLUDE_CATALOG=1 also packs catalog/.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "directus-extension-backport");
const out = path.join(ext, "directus-extension-backport.zip");
const includeCatalog = process.env.INCLUDE_CATALOG === "1" || process.env.INCLUDE_CATALOG === "true";

const required = [
	"package.json",
	"dist/app.js",
	"dist/api.js",
	"dist/cli.mjs",
	"dist/rollback.mjs",
];

function run(cmd, args, cwd) {
	const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!fs.existsSync(path.join(ext, "dist", "cli.mjs")) || !fs.existsSync(path.join(ext, "dist", "api.js"))) {
	console.log("Running extension build…");
	run("npm", ["run", "build"], ext);
}

for (const rel of required) {
	if (!fs.existsSync(path.join(ext, rel))) {
		console.error(`Missing ${rel}. Run: cd directus-extension-backport && npm run build`);
		process.exit(1);
	}
}

if (includeCatalog && !fs.existsSync(path.join(ext, "catalog", "advisories.yml"))) {
	console.log("INCLUDE_CATALOG=1 — copying repo catalog into the extension…");
	fs.rmSync(path.join(ext, "catalog"), { recursive: true, force: true });
	run("cp", ["-r", path.join(root, "catalog"), path.join(ext, "catalog")], root);
}

const zipArgs = ["-rq", out, "package.json", "dist", "README.md"];
if (includeCatalog) zipArgs.push("catalog");
zipArgs.push("-x", "catalog-remote/*", "desired.json");

fs.rmSync(out, { force: true });
run("zip", zipArgs, ext);

const listing = spawnSync("unzip", ["-l", out], { encoding: "utf8" });
for (const must of ["package.json", "dist/api.js", "dist/cli.mjs", "dist/rollback.mjs"]) {
	if (!listing.stdout?.includes(must)) {
		console.error(`Zip is missing ${must}`);
		process.exit(1);
	}
}
if (includeCatalog && !listing.stdout?.includes("catalog/advisories.yml")) {
	console.error("INCLUDE_CATALOG=1 but zip is missing catalog/advisories.yml");
	process.exit(1);
}
if (!includeCatalog && listing.stdout?.includes("catalog/advisories.yml")) {
	console.error("Default zip must not include catalog/; use INCLUDE_CATALOG=1");
	process.exit(1);
}

const st = fs.statSync(out);
console.log(`Wrote ${out} (${st.size} bytes)`);
console.log("Contents: package.json, dist/{api,app,cli,rollback}.js(mjs), README.md");
if (includeCatalog) {
	console.log("Also includes catalog/ (offline).");
} else {
	console.log("No catalog/ — operators use Check for Updates / catalog --refresh.");
}
console.log("Unpack into …/extensions/directus-extension-backport/");
