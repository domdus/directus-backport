#!/usr/bin/env node
/**
 * Sign catalog/ with the offline Ed25519 key. Run this on a trusted machine, never in CI.
 *
 *   node scripts/sign-catalog.mjs --generate-key ~/.config/directus-backport/catalog-signing.pem
 *   DIRECTUS_BACKPORT_SIGNING_KEY=<path> npm run sign:catalog
 *
 * Writes catalog/manifest.json (sha256 of every file, plus a growing sequence) and
 * catalog/manifest.sig. Installs refuse a download without a valid signature.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = path.join(root, "catalog");
const SIGNABLE = /\.(yml|yaml|md|patch|txt)$/i;

function publicKeyOf(privateKey) {
	return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

const genAt = process.argv.indexOf("--generate-key");
if (genAt >= 0) {
	const out = path.resolve(process.argv[genAt + 1] || "");
	if (!process.argv[genAt + 1]) throw new Error("--generate-key needs a path");
	if (out.startsWith(root + path.sep)) throw new Error("Keep the private key outside this repository.");
	if (fs.existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
	const { privateKey } = generateKeyPairSync("ed25519");
	fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
	fs.writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
	console.log(`Wrote ${out}`);
	console.log(`Public key for TRUSTED_KEYS in src/trust.ts:\n${publicKeyOf(privateKey)}`);
	process.exit(0);
}

const keyFile = process.env.DIRECTUS_BACKPORT_SIGNING_KEY;
if (!keyFile) throw new Error("Set DIRECTUS_BACKPORT_SIGNING_KEY to the private key path.");
const privateKey = createPrivateKey(fs.readFileSync(keyFile));

function walk(dir, prefix = "") {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
	});
}

const files = {};
for (const rel of walk(catalog).filter((file) => SIGNABLE.test(file) && file !== "source.yml").sort()) {
	files[rel] = createHash("sha256").update(fs.readFileSync(path.join(catalog, rel))).digest("hex");
}

const manifestPath = path.join(catalog, "manifest.json");
let previous = 0;
if (fs.existsSync(manifestPath)) previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")).sequence ?? 0;
const sequence = Math.max(previous + 1, Math.floor(Date.now() / 1000));

const manifest = Buffer.from(`${JSON.stringify({ manifest_version: 1, sequence, files }, null, "\t")}\n`);
fs.writeFileSync(manifestPath, manifest);
fs.writeFileSync(path.join(catalog, "manifest.sig"), `${sign(null, manifest, privateKey).toString("base64")}\n`);
console.log(`Signed ${Object.keys(files).length} files, sequence ${sequence}`);
