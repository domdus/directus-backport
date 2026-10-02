import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadCatalogSource } from "../src/catalog-source.js";
import { catalogRelFromTarPath, extractCatalogTarGz } from "../src/tar-catalog.js";

describe("GitHub catalog marketplace", () => {
	it("defaults to domdus/directus-backport on main", () => {
		const prev = process.env.DIRECTUS_BACKPORT_CATALOG;
		const prevRef = process.env.DIRECTUS_BACKPORT_CATALOG_REF;
		try {
			delete process.env.DIRECTUS_BACKPORT_CATALOG;
			delete process.env.DIRECTUS_BACKPORT_CATALOG_REF;
			const source = loadCatalogSource();
			assert.equal(source.github, "domdus/directus-backport");
			assert.equal(source.ref, "main");
			assert.equal(
				source.tarballUrl,
				"https://codeload.github.com/domdus/directus-backport/tar.gz/main",
			);
		} finally {
			if (prev === undefined) delete process.env.DIRECTUS_BACKPORT_CATALOG;
			else process.env.DIRECTUS_BACKPORT_CATALOG = prev;
			if (prevRef === undefined) delete process.env.DIRECTUS_BACKPORT_CATALOG_REF;
			else process.env.DIRECTUS_BACKPORT_CATALOG_REF = prevRef;
		}
	});

	it("parses owner/repo and GitHub URLs", () => {
		const prev = process.env.DIRECTUS_BACKPORT_CATALOG;
		const prevRef = process.env.DIRECTUS_BACKPORT_CATALOG_REF;
		try {
			process.env.DIRECTUS_BACKPORT_CATALOG = "acme/directus-backport";
			process.env.DIRECTUS_BACKPORT_CATALOG_REF = "v1";
			const source = loadCatalogSource();
			assert.equal(source.github, "acme/directus-backport");
			assert.equal(source.ref, "v1");
			assert.equal(source.tarballUrl, "https://codeload.github.com/acme/directus-backport/tar.gz/v1");

			process.env.DIRECTUS_BACKPORT_CATALOG = "https://github.com/acme/directus-backport.git";
			assert.equal(loadCatalogSource().github, "acme/directus-backport");
		} finally {
			if (prev === undefined) delete process.env.DIRECTUS_BACKPORT_CATALOG;
			else process.env.DIRECTUS_BACKPORT_CATALOG = prev;
			if (prevRef === undefined) delete process.env.DIRECTUS_BACKPORT_CATALOG_REF;
			else process.env.DIRECTUS_BACKPORT_CATALOG_REF = prevRef;
		}
	});

	it("maps tarball paths under catalog/ and rejects the rest", () => {
		assert.equal(catalogRelFromTarPath("repo-main/catalog/advisories.yml"), "advisories.yml");
		assert.equal(
			catalogRelFromTarPath("repo-main/catalog/patches/GHSA-test-0000-0000/targets.yml"),
			"patches/GHSA-test-0000-0000/targets.yml",
		);
		assert.equal(catalogRelFromTarPath("repo-main/src/engine.ts"), null);
		assert.equal(catalogRelFromTarPath("repo-main/catalog/../secret.yml"), null);
		assert.equal(catalogRelFromTarPath("repo-main/catalog/evil.js"), null);
	});

	it("extracts catalog/ from a GitHub-style tar.gz", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-tar-"));
		const repo = path.join(root, "directus-backport-main");
		fs.mkdirSync(path.join(repo, "catalog", "patches", "GHSA-test-0000-0000"), { recursive: true });
		fs.writeFileSync(
			path.join(repo, "catalog", "advisories.yml"),
			"catalog_version: 1\nadvisories: []\n",
		);
		fs.writeFileSync(path.join(repo, "catalog", "patches", "GHSA-test-0000-0000", "targets.yml"), "- file: x\n");
		fs.writeFileSync(path.join(repo, "README.md"), "nope\n");
		const tgz = path.join(root, "src.tar.gz");
		const packed = spawnSync("tar", ["-czf", tgz, "-C", root, "directus-backport-main"], { encoding: "utf8" });
		assert.equal(packed.status, 0, packed.stderr);
		const dest = path.join(root, "out");
		const { files } = extractCatalogTarGz(fs.readFileSync(tgz), dest);
		assert.ok(files.includes("advisories.yml"));
		assert.ok(files.includes("patches/GHSA-test-0000-0000/targets.yml"));
		assert.ok(!files.some((file) => file.includes("README")));
		assert.equal(fs.readFileSync(path.join(dest, "advisories.yml"), "utf8"), "catalog_version: 1\nadvisories: []\n");
	});
});
