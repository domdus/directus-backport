import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { loadCatalog, partitionAdvisories } from "../src/catalog.js";
import { detectInstall } from "../src/detect.js";
import { applyPatches, ensureDesiredApplied, rollbackAdvisory, rollbackAll, rollbackLast, statusReport } from "../src/engine.js";
import { probeWriteAccess } from "../src/writable.js";
import { findPackageRoot } from "../src/paths.js";
import { sha256 } from "../src/patch.js";

const original = "export function ping() { return 'old'; }\n";
const patched = "export function ping() { return 'new'; }\n";

function makeInstall(version = "11.17.4") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-"));
	const nodeModules = path.join(root, "node_modules");
	fs.mkdirSync(path.join(nodeModules, "@directus", "api", "dist"), { recursive: true });
	fs.mkdirSync(path.join(nodeModules, "directus"), { recursive: true });
	fs.writeFileSync(
		path.join(nodeModules, "directus", "package.json"),
		JSON.stringify({ name: "directus", version }, null, 2),
	);
	const target = path.join(nodeModules, "@directus", "api", "dist", "demo.js");
	fs.writeFileSync(target, original);
	return { root, nodeModules, target };
}

function makeCatalog(dir: string, status: "experimental" | "needs-port" = "experimental") {
	const catalogDir = path.join(dir, "catalog");
	fs.mkdirSync(catalogDir, { recursive: true });
	const doc = {
		catalog_version: 1,
		advisories: [
			{
				id: "GHSA-test-0000-0000",
				title: "Fixture patch for tests",
				severity: "low",
				advisory: "https://example.invalid",
				affects: "< 12.0.0",
				upstream_patched: "12.0.0",
				port: {
					status,
					risk: "low",
					notes: "test",
					targets: [
						{
							file: "@directus/api/dist/demo.js",
							before_sha256: sha256(original),
							after_sha256: sha256(patched),
							replace: [{ from: "return 'old'", to: "return 'new'" }],
						},
					],
				},
			},
		],
	};
	fs.writeFileSync(path.join(catalogDir, "advisories.yml"), stringifyYaml(doc));
	return catalogDir;
}

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
	return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("no port");
			resolve({
				url: `http://127.0.0.1:${addr.port}/server/ping`,
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}

describe("bundled catalog", () => {
	it("loads GHSA entries and classifies 11.17.4", () => {
		const catalog = loadCatalog(path.join(findPackageRoot(), "catalog"));
		assert.ok(catalog.advisories.length >= 20);
		const parts = partitionAdvisories(catalog, "11.17.4");
		assert.ok(parts.open.some((a) => a.id === "GHSA-97xr-jchp-xm3c"));
		assert.ok(parts.alreadyFixed.some((a) => a.id === "GHSA-38hg-ww64-rrwc"));
		assert.equal(parts.waiting.length, 0);
		assert.equal(parts.ready.length, 21);
		assert.ok(parts.ready.some((a) => a.id === "GHSA-xw72-c69j-h2rj"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-97xr-jchp-xm3c"));
	});

	it("classifies 10.13.4 with version-specific pins", () => {
		const catalog = loadCatalog(path.join(findPackageRoot(), "catalog"));
		const parts = partitionAdvisories(catalog, "10.13.4");
		assert.equal(parts.alreadyFixed.length, 0);
		assert.equal(parts.ready.length, 17);
		assert.equal(parts.waiting.length, 9);
		assert.ok(parts.ready.some((a) => a.id === "GHSA-97xr-jchp-xm3c"));
		assert.ok(parts.ready.every((a) => a.port.targets.some((t) => (t.pin || "11.17.4") === "10.13.4")));
		assert.ok(parts.waiting.some((a) => a.id === "GHSA-38hg-ww64-rrwc"));
		assert.ok(!parts.open.some((a) => a.id === "GHSA-4jw7-6mqj-vrhq"));
		assert.ok(!parts.open.some((a) => a.id === "GHSA-fq27-7m2r-q6vm"));
	});

	it("classifies 9.26.0 with CLI-only pins", () => {
		const catalog = loadCatalog(path.join(findPackageRoot(), "catalog"));
		const parts = partitionAdvisories(catalog, "9.26.0");
		assert.equal(parts.alreadyFixed.length, 0);
		assert.equal(parts.ready.length, 18);
		assert.equal(parts.waiting.length, 4);
		assert.ok(parts.ready.some((a) => a.id === "GHSA-wxwm-3fxv-mrvx"));
		assert.ok(parts.ready.every((a) => a.port.targets.some((t) => t.pin === "9.26.0")));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-c6w9-5g5j-jh2p"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-chfm-g7r3-vv42"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-g293-vf99-xv36"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-788p-cvgf-q973"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-gwvv-rr68-cmv6"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-xw72-c69j-h2rj"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-38hg-ww64-rrwc"));
		assert.ok(parts.ready.some((a) => a.id === "GHSA-cf45-hxwj-4cfj"));
		assert.ok(!parts.open.some((a) => a.id === "GHSA-mww8-4gwh-rjfw"));
		assert.ok(!parts.ready.some((a) => a.id === "GHSA-97xr-jchp-xm3c"));
	});
});

describe("apply / rollback", () => {
	it("detects a fake Directus install", () => {
		const { root, target } = makeInstall();
		const install = detectInstall(root);
		assert.equal(install.version, "11.17.4");
		assert.equal(fs.readFileSync(target, "utf8"), original);
	});

	it("detects Directus when package.json is at the install root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-root-pkg-"));
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "directus", version: "9.26.0" }));
		fs.mkdirSync(path.join(root, "node_modules"));
		const install = detectInstall(root);
		assert.equal(install.version, "9.26.0");
		assert.equal(install.root, path.resolve(root));
		assert.equal(install.nodeModules, path.join(root, "node_modules"));
	});

	it("walks up from an extension folder to the Directus root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-ext-walk-"));
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "directus", version: "9.26.0" }));
		fs.mkdirSync(path.join(root, "node_modules"));
		const ext = path.join(root, "extensions", "directus-extension-backport");
		fs.mkdirSync(ext, { recursive: true });
		const install = detectInstall(ext);
		assert.equal(install.version, "9.26.0");
		assert.equal(install.root, path.resolve(root));
	});

	it("refuses a needs-port advisory", async () => {
		const { root } = makeInstall();
		const catalogDir = makeCatalog(root, "needs-port");
		const install = detectInstall(root);
		await assert.rejects(
			() => applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir),
			/no applyable backport/,
		);
	});

	it("applies a replacement patch and rolls back from snapshot", async () => {
		const { root, target } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		const result = await applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir);
		assert.equal(result.ok, true);
		assert.equal(fs.readFileSync(target, "utf8"), patched);
		const afterApply = statusReport(install, catalogDir);
		assert.ok(afterApply.appliedIds.includes("GHSA-test-0000-0000"));
		assert.equal(afterApply.ready.length, 0);
		assert.equal(afterApply.counts.ready, 0);
		assert.equal(afterApply.appliedCatalog.length, 1);
		assert.deepEqual(afterApply.lastApplyIds, ["GHSA-test-0000-0000"]);
		rollbackLast(install, catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), original);
		assert.equal(statusReport(install, catalogDir).ready.length, 1);
	});

	it("refuses to apply when the checksum does not match", async () => {
		const { root, target } = makeInstall();
		fs.writeFileSync(target, "export function ping() { return 'tampered'; }\n");
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		const result = await applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir);
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.match(result.error ?? "", /Checksum mismatch/);
		assert.equal(fs.readFileSync(target, "utf8"), "export function ping() { return 'tampered'; }\n");
	});

	it("auto-rolls back when the health URL never comes up", async () => {
		const { root, target } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		const result = await applyPatches(
			install,
			{
				ids: ["GHSA-test-0000-0000"],
				healthUrl: "http://127.0.0.1:1/server/ping",
				healthTimeoutMs: 200,
				rollbackOnFail: true,
			},
			catalogDir,
		);
		assert.equal(result.ok, false);
		assert.equal(result.rolledBack, true);
		assert.equal(fs.readFileSync(target, "utf8"), original);
	});

	it("keeps the patch when health succeeds", async () => {
		const { root, target } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("pong");
		});
		try {
			const result = await applyPatches(
				install,
				{
					ids: ["GHSA-test-0000-0000"],
					healthUrl: server.url,
					healthTimeoutMs: 5000,
					rollbackOnFail: true,
				},
				catalogDir,
			);
			assert.equal(result.ok, true);
			assert.equal(result.health, "ok");
			assert.equal(fs.readFileSync(target, "utf8"), patched);
		} finally {
			await server.close();
		}
	});

	it("rolls back one advisory without undoing others", async () => {
		const vanilla = "alpha bravo charlie\n";
		const { root, nodeModules } = makeInstall();
		const target = path.join(nodeModules, "@directus", "api", "dist", "demo.js");
		fs.writeFileSync(target, vanilla);
		const catalogDir = path.join(root, "catalog");
		fs.mkdirSync(catalogDir, { recursive: true });
		fs.writeFileSync(
			path.join(catalogDir, "advisories.yml"),
			stringifyYaml({
				catalog_version: 1,
				advisories: [
					{
						id: "GHSA-test-1111-1111",
						title: "First",
						severity: "low",
						advisory: "https://example.invalid/1",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "alpha", to: "ALPHA" }],
								},
							],
						},
					},
					{
						id: "GHSA-test-2222-2222",
						title: "Second",
						severity: "low",
						advisory: "https://example.invalid/2",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "bravo", to: "BRAVO" }],
								},
							],
						},
					},
				],
			}),
		);
		const install = detectInstall(root);
		const result = await applyPatches(
			install,
			{ ids: ["GHSA-test-2222-2222", "GHSA-test-1111-1111"] },
			catalogDir,
		);
		assert.equal(result.ok, true);
		assert.deepEqual(result.applied, ["GHSA-test-1111-1111", "GHSA-test-2222-2222"]);
		assert.equal(fs.readFileSync(target, "utf8"), "ALPHA BRAVO charlie\n");
		const afterApply = statusReport(install, catalogDir);
		assert.deepEqual(afterApply.lastApplyIds, ["GHSA-test-2222-2222"]);
		assert.notEqual(afterApply.applied[0]?.snapshot, afterApply.applied[1]?.snapshot);

		rollbackAdvisory(install, "GHSA-test-1111-1111", catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), "alpha BRAVO charlie\n");
		const afterOne = statusReport(install, catalogDir);
		assert.deepEqual(afterOne.appliedIds, ["GHSA-test-2222-2222"]);
		assert.equal(afterOne.ready.length, 1);
		assert.equal(afterOne.ready[0]?.id, "GHSA-test-1111-1111");

		rollbackAdvisory(install, "GHSA-test-2222-2222", catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), vanilla);
		assert.equal(statusReport(install, catalogDir).applied.length, 0);
	});

	it("rollback last undoes only the most recently applied remaining patch", async () => {
		const vanilla = "alpha bravo charlie\n";
		const { root, nodeModules } = makeInstall();
		const target = path.join(nodeModules, "@directus", "api", "dist", "demo.js");
		fs.writeFileSync(target, vanilla);
		const catalogDir = path.join(root, "catalog");
		fs.mkdirSync(catalogDir, { recursive: true });
		fs.writeFileSync(
			path.join(catalogDir, "advisories.yml"),
			stringifyYaml({
				catalog_version: 1,
				advisories: [
					{
						id: "GHSA-test-1111-1111",
						title: "First",
						severity: "low",
						advisory: "https://example.invalid/1",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "alpha", to: "ALPHA" }],
								},
							],
						},
					},
					{
						id: "GHSA-test-2222-2222",
						title: "Second",
						severity: "low",
						advisory: "https://example.invalid/2",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256("ALPHA bravo charlie\n"),
									replace: [{ from: "bravo", to: "BRAVO" }],
								},
							],
						},
					},
				],
			}),
		);
		const install = detectInstall(root);
		await applyPatches(install, { ids: ["GHSA-test-1111-1111", "GHSA-test-2222-2222"] }, catalogDir);
		assert.deepEqual(statusReport(install, catalogDir).lastApplyIds, ["GHSA-test-2222-2222"]);
		rollbackLast(install, catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), "ALPHA bravo charlie\n");
		const afterLast = statusReport(install, catalogDir);
		assert.deepEqual(afterLast.appliedIds, ["GHSA-test-1111-1111"]);
		assert.deepEqual(afterLast.lastApplyIds, ["GHSA-test-1111-1111"]);
	});

	it("rollback all restores every applied backport", async () => {
		const vanilla = "alpha bravo charlie\n";
		const { root, nodeModules } = makeInstall();
		const target = path.join(nodeModules, "@directus", "api", "dist", "demo.js");
		fs.writeFileSync(target, vanilla);
		const catalogDir = path.join(root, "catalog");
		fs.mkdirSync(catalogDir, { recursive: true });
		fs.writeFileSync(
			path.join(catalogDir, "advisories.yml"),
			stringifyYaml({
				catalog_version: 1,
				advisories: [
					{
						id: "GHSA-test-1111-1111",
						title: "First",
						severity: "low",
						advisory: "https://example.invalid/1",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "alpha", to: "ALPHA" }],
								},
							],
						},
					},
					{
						id: "GHSA-test-2222-2222",
						title: "Second",
						severity: "low",
						advisory: "https://example.invalid/2",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256("ALPHA bravo charlie\n"),
									replace: [{ from: "bravo", to: "BRAVO" }],
								},
							],
						},
					},
				],
			}),
		);
		const install = detectInstall(root);
		await applyPatches(install, { ids: ["GHSA-test-1111-1111", "GHSA-test-2222-2222"] }, catalogDir);
		rollbackAll(install, catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), vanilla);
		assert.equal(statusReport(install, catalogDir).applied.length, 0);
	});

	it("keeps a later same-file patch when rolling back an earlier one", async () => {
		const vanilla = "alpha bravo charlie\n";
		const { root, nodeModules } = makeInstall();
		const target = path.join(nodeModules, "@directus", "api", "dist", "demo.js");
		fs.writeFileSync(target, vanilla);
		const catalogDir = path.join(root, "catalog");
		fs.mkdirSync(catalogDir, { recursive: true });
		fs.writeFileSync(
			path.join(catalogDir, "advisories.yml"),
			stringifyYaml({
				catalog_version: 1,
				advisories: [
					{
						id: "GHSA-test-aaaa-aaaa",
						title: "A",
						severity: "low",
						advisory: "https://example.invalid/a",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "alpha", to: "ALPHA" }],
								},
							],
						},
					},
					{
						id: "GHSA-test-bbbb-bbbb",
						title: "B",
						severity: "low",
						advisory: "https://example.invalid/b",
						affects: "< 12.0.0",
						upstream_patched: "12.0.0",
						port: {
							status: "experimental",
							risk: "low",
							targets: [
								{
									file: "@directus/api/dist/demo.js",
									before_sha256: sha256(vanilla),
									replace: [{ from: "bravo", to: "BRAVO" }],
								},
							],
						},
					},
				],
			}),
		);
		const install = detectInstall(root);
		await applyPatches(install, { ids: ["GHSA-test-aaaa-aaaa", "GHSA-test-bbbb-bbbb"] }, catalogDir);
		rollbackAdvisory(install, "GHSA-test-bbbb-bbbb", catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), "ALPHA bravo charlie\n");
		assert.deepEqual(statusReport(install, catalogDir).appliedIds, ["GHSA-test-aaaa-aaaa"]);
	});

	it("reports writable on a normal temp install", () => {
		const { root } = makeInstall();
		const write = probeWriteAccess(detectInstall(root));
		assert.equal(write.writable, true);
		assert.equal(write.snapshotWritable, true);
		assert.equal(write.nodeModulesWritable, true);
	});

	it("refuses apply when node_modules files are not writable", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			return;
		}
		const { root, nodeModules, target } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		fs.chmodSync(target, 0o444);
		fs.chmodSync(path.join(nodeModules, "directus", "package.json"), 0o444);
		try {
			const write = probeWriteAccess(install);
			assert.equal(write.writable, false);
			const result = await applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /Cannot write|not writable/i);
			assert.equal(fs.readFileSync(target, "utf8"), original);
		} finally {
			fs.chmodSync(target, 0o644);
			fs.chmodSync(path.join(nodeModules, "directus", "package.json"), 0o644);
		}
	});
});

describe("desired persist", () => {
	it("writes desired.json on apply and clears it on rollback", async () => {
		const { root, target } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		await applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir);
		const desiredFile = path.join(root, "desired.json");
		assert.equal(fs.existsSync(desiredFile), true);
		const desired = JSON.parse(fs.readFileSync(desiredFile, "utf8"));
		assert.deepEqual(desired.ids, ["GHSA-test-0000-0000"]);
		assert.equal(desired.version, "11.17.4");
		rollbackLast(install, catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), original);
		const after = JSON.parse(fs.readFileSync(desiredFile, "utf8"));
		assert.deepEqual(after.ids, []);
	});

	it("re-applies from desired.json after node_modules is reset", async () => {
		const { root, target, nodeModules } = makeInstall();
		const catalogDir = makeCatalog(root);
		const install = detectInstall(root);
		await applyPatches(install, { ids: ["GHSA-test-0000-0000"] }, catalogDir);
		assert.equal(fs.readFileSync(target, "utf8"), patched);
		fs.writeFileSync(target, original);
		fs.rmSync(path.join(nodeModules, "..", ".directus-backport"), { recursive: true, force: true });
		const result = await ensureDesiredApplied(install, catalogDir);
		assert.equal(result.wrote, true);
		assert.deepEqual(result.applied, ["GHSA-test-0000-0000"]);
		assert.equal(fs.readFileSync(target, "utf8"), patched);
		const second = await ensureDesiredApplied(install, catalogDir);
		assert.equal(second.wrote, false);
		assert.equal(second.skipped, true);
	});
});
