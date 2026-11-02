import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { refreshRemoteCatalog } from "../src/catalog-fetch.js";
import { loadCatalogSource, remoteCatalogDir } from "../src/catalog-source.js";
import { applyPatches } from "../src/engine.js";
import { detectInstall } from "../src/detect.js";
import { catalogRelFromTarPath } from "../src/tar-catalog.js";
import { buildManifest, verifyCatalogDir } from "../src/trust.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rogue = generateKeyPairSync("ed25519").privateKey;
const ADV = "catalog_version: 1\nadvisories: []\n";

function signDir(dir: string, sequence = 5, key = privateKey) {
	const bytes = Buffer.from(JSON.stringify(buildManifest(dir, sequence)));
	fs.writeFileSync(path.join(dir, "manifest.json"), bytes);
	fs.writeFileSync(path.join(dir, "manifest.sig"), sign(null, bytes, key).toString("base64"));
}

function catalogDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-trust-"));
	fs.writeFileSync(path.join(dir, "advisories.yml"), ADV);
	return dir;
}

function tarball(catalog: string): Buffer {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-tgz-"));
	fs.mkdirSync(path.join(root, "repo-main"));
	fs.cpSync(catalog, path.join(root, "repo-main", "catalog"), { recursive: true });
	const file = path.join(root, "x.tgz");
	const packed = spawnSync("tar", ["-czf", file, "-C", root, "repo-main"]);
	assert.equal(packed.status, 0);
	return fs.readFileSync(file);
}

function serve(archive: Buffer): void {
	globalThis.fetch = (async () => new Response(archive)) as typeof fetch;
}

const realFetch = globalThis.fetch;
const env = { key: process.env.DIRECTUS_BACKPORT_TRUSTED_KEY, ext: process.env.DIRECTUS_BACKPORT_EXTENSION };

describe("catalog signatures", () => {
	before(() => {
		process.env.DIRECTUS_BACKPORT_TRUSTED_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const ext = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-ext-"));
		fs.writeFileSync(path.join(ext, "package.json"), JSON.stringify({ name: "directus-extension-backport" }));
		process.env.DIRECTUS_BACKPORT_EXTENSION = ext;
	});

	after(() => {
		globalThis.fetch = realFetch;
		if (env.key === undefined) delete process.env.DIRECTUS_BACKPORT_TRUSTED_KEY;
		else process.env.DIRECTUS_BACKPORT_TRUSTED_KEY = env.key;
		if (env.ext === undefined) delete process.env.DIRECTUS_BACKPORT_EXTENSION;
		else process.env.DIRECTUS_BACKPORT_EXTENSION = env.ext;
	});

	it("accepts what a trusted key signed", () => {
		const dir = catalogDir();
		signDir(dir);
		assert.equal(verifyCatalogDir(dir).sequence, 5);
	});

	it("rejects an unsigned catalog", () => {
		assert.throws(() => verifyCatalogDir(catalogDir()), /not signed/);
	});

	it("rejects a signature from another key", () => {
		const dir = catalogDir();
		signDir(dir, 5, rogue);
		assert.throws(() => verifyCatalogDir(dir), /trusted key/);
	});

	it("rejects a patch edited after signing", () => {
		const dir = catalogDir();
		signDir(dir);
		fs.appendFileSync(path.join(dir, "advisories.yml"), "# changed\n");
		assert.throws(() => verifyCatalogDir(dir), /changed after signing/);
	});

	it("rejects a patch file added after signing", () => {
		const dir = catalogDir();
		signDir(dir);
		fs.mkdirSync(path.join(dir, "patches", "GHSA-test-0000-0000"), { recursive: true });
		fs.writeFileSync(path.join(dir, "patches", "GHSA-test-0000-0000", "targets.yml"), "[]\n");
		assert.throws(() => verifyCatalogDir(dir), /signed manifest/);
	});

	it("keeps the old cache when a download is not signed", async () => {
		const good = catalogDir();
		signDir(good, 5);
		serve(tarball(good));
		await refreshRemoteCatalog();
		serve(tarball(catalogDir()));
		await assert.rejects(refreshRemoteCatalog(), /not signed/);
		assert.equal(verifyCatalogDir(remoteCatalogDir()).sequence, 5);
	});

	it("refuses to go back to an older signed catalog", async () => {
		const older = catalogDir();
		signDir(older, 4);
		serve(tarball(older));
		await assert.rejects(refreshRemoteCatalog(), /older catalog/);
	});

	it("refuses to apply from a cache that was changed on disk", async () => {
		const remote = remoteCatalogDir();
		fs.appendFileSync(path.join(remote, "advisories.yml"), "# changed\n");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-app-"));
		fs.mkdirSync(path.join(root, "node_modules", "directus"), { recursive: true });
		fs.writeFileSync(path.join(root, "node_modules", "directus", "package.json"), JSON.stringify({ name: "directus", version: "11.17.4" }));
		await assert.rejects(applyPatches(detectInstall(root), { ids: ["GHSA-test-0000-0000"] }, remote), /changed after signing/);
	});

	it("never takes source.yml from a download", () => {
		assert.equal(catalogRelFromTarPath("repo-main/catalog/source.yml"), null);
		fs.writeFileSync(path.join(remoteCatalogDir(), "source.yml"), "github: attacker/repo\n");
		assert.equal(loadCatalogSource().github, "domdus/directus-backport");
	});
});
