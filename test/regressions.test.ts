import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { loadCatalog, statusForVersion } from "../src/catalog.js";
import { detectInstall } from "../src/detect.js";
import {
	applyPatches,
	ensureDesiredApplied,
	noteBootHealthy,
	noteBootStart,
	rollbackAdvisory,
	rollbackSnapshot,
	statusReport,
} from "../src/engine.js";
import { sha256 } from "../src/patch.js";
import { loadState } from "../src/state.js";

const A = "GHSA-aaaa-aaaa-aaaa";
const B = "GHSA-bbbb-bbbb-bbbb";
const C = "GHSA-cccc-cccc-cccc";
const DEMO = "@directus/api/dist/demo.js";
const OTHER = "@directus/api/dist/other.js";
const pristine = "const one = 1;\nconst two = 2;\nexport { one, two };\n";
const otherPristine = "export const three = 3;\n";

type Patch = { id: string; file?: string; from: string; to: string; before?: string };

function advisory(patch: Patch) {
	const before = patch.before ?? (patch.file === OTHER ? otherPristine : pristine);
	return {
		id: patch.id,
		title: patch.id,
		severity: "high",
		advisory: "https://example.invalid",
		affects: "< 12.0.0",
		upstream_patched: "12.0.0",
		port: {
			status: "experimental",
			risk: "low",
			targets: [
				{
					file: patch.file ?? DEMO,
					before_sha256: sha256(before),
					after_sha256: sha256(before.split(patch.from).join(patch.to)),
					replace: [{ from: patch.from, to: patch.to }],
				},
			],
		},
	};
}

function setup(patches: Patch[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-reg-"));
	const nodeModules = path.join(root, "node_modules");
	fs.mkdirSync(path.join(nodeModules, "@directus", "api", "dist"), { recursive: true });
	fs.mkdirSync(path.join(nodeModules, "directus"), { recursive: true });
	fs.writeFileSync(path.join(nodeModules, "directus", "package.json"), JSON.stringify({ name: "directus", version: "11.17.4" }));
	fs.writeFileSync(path.join(nodeModules, "@directus", "api", "package.json"), JSON.stringify({ type: "module" }));
	const demo = path.join(nodeModules, DEMO);
	const other = path.join(nodeModules, OTHER);
	fs.writeFileSync(demo, pristine);
	fs.writeFileSync(other, otherPristine);
	const catalog = path.join(root, "catalog");
	fs.mkdirSync(catalog);
	fs.writeFileSync(path.join(catalog, "advisories.yml"), stringifyYaml({ catalog_version: 1, advisories: patches.map(advisory) }));
	const prev = process.env.DIRECTUS_BACKPORT_DESIRED;
	process.env.DIRECTUS_BACKPORT_DESIRED = path.join(root, "desired.json");
	return { root, nodeModules, demo, other, catalog, install: detectInstall(root), restore: () => {
		if (prev === undefined) delete process.env.DIRECTUS_BACKPORT_DESIRED;
		else process.env.DIRECTUS_BACKPORT_DESIRED = prev;
	} };
}

// The replacement keeps the search text, as a patch that only inserts code does.
const insertion: Patch = { id: A, from: "const one = 1;", to: "const one = 1;\nconst guard = true;" };
const second: Patch = { id: B, from: "const two = 2;", to: "const two = 22;" };

describe("insertion patches", () => {
	it("rollback really removes the patch and re-apply inserts it once", async () => {
		const t = setup([insertion]);
		try {
			await applyPatches(t.install, { ids: [A] }, t.catalog);
			rollbackAdvisory(t.install, A, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
			await applyPatches(t.install, { ids: [A] }, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8").split("const guard").length - 1, 1);
		} finally {
			t.restore();
		}
	});

	it("does not insert twice when state.json is gone", async () => {
		const t = setup([insertion]);
		try {
			await applyPatches(t.install, { ids: [A] }, t.catalog);
			const patched = fs.readFileSync(t.demo, "utf8");
			fs.rmSync(path.join(t.root, ".directus-backport"), { recursive: true });
			const report = statusReport(t.install, t.catalog);
			assert.deepEqual(report.appliedIds, [A]);
			assert.deepEqual(report.drift.untracked, [A]);
			assert.equal(report.ready.length, 0);
			assert.equal(fs.readFileSync(t.demo, "utf8"), patched);
			rollbackAdvisory(t.install, A, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
		} finally {
			t.restore();
		}
	});
});

describe("overlapping patches", () => {
	const both = "const one = 1;\nconst two = 2;";
	// The second patch edits code inside the block the first one wrote.
	const wide: Patch = { id: A, from: both, to: `${both}\nconst guard = true;` };
	const narrow: Patch = { id: B, from: "const two = 2;", to: "const two = 22;" };
	const stacked = pristine.replace(both, "const one = 1;\nconst two = 22;\nconst guard = true;");

	it("finds both from the bytes alone", async () => {
		const t = setup([wide, narrow]);
		try {
			await applyPatches(t.install, { ids: [A, B] }, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), stacked);
			fs.rmSync(path.join(t.root, ".directus-backport"), { recursive: true });
			assert.deepEqual(statusReport(t.install, t.catalog).appliedIds.sort(), [A, B]);
		} finally {
			t.restore();
		}
	});

	it("rolls back the buried patch first and keeps the other", async () => {
		const t = setup([wide, narrow]);
		try {
			await applyPatches(t.install, { ids: [A, B] }, t.catalog);
			fs.rmSync(path.join(t.root, ".directus-backport"), { recursive: true });
			statusReport(t.install, t.catalog);
			rollbackAdvisory(t.install, A, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine.replace("const two = 2;", "const two = 22;"));
			rollbackAdvisory(t.install, B, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
		} finally {
			t.restore();
		}
	});
});

describe("the files decide what is applied", () => {
	it("reports a reset node_modules as unprotected and re-applies it", async () => {
		const t = setup([insertion, second]);
		try {
			await applyPatches(t.install, { ids: [A, B] }, t.catalog);
			fs.writeFileSync(t.demo, pristine);
			const stale = statusReport(t.install, t.catalog);
			assert.equal(stale.counts.applied, 0);
			assert.deepEqual(stale.drift.missing.sort(), [A, B]);
			assert.deepEqual(stale.unprotected.sort(), [A, B]);
			const result = await ensureDesiredApplied(t.install, t.catalog);
			assert.equal(result.wrote, true);
			assert.equal(statusReport(t.install, t.catalog).unprotected.length, 0);
			const again = await ensureDesiredApplied(t.install, t.catalog);
			assert.equal(again.wrote, false);
		} finally {
			t.restore();
		}
	});
});

describe("boot re-apply", () => {
	it("keeps the fixes it can apply when one file was changed", async () => {
		const t = setup([insertion, { id: C, file: OTHER, from: "three = 3", to: "three = 33" }]);
		try {
			await applyPatches(t.install, { ids: [A, C] }, t.catalog);
			fs.writeFileSync(t.demo, pristine);
			fs.writeFileSync(t.other, "export const three = 3; // local\n");
			const result = await ensureDesiredApplied(t.install, t.catalog);
			assert.deepEqual(result.applied, [A]);
			assert.equal(result.wrote, true);
			assert.deepEqual(result.failed.map((item) => item.id), [C]);
			assert.match(result.error ?? "", new RegExp(C));
			assert.deepEqual(statusReport(t.install, t.catalog).lastReapply?.failed.map((item) => item.id), [C]);
		} finally {
			t.restore();
		}
	});

	it("names an id the catalog no longer offers", async () => {
		const t = setup([insertion]);
		try {
			fs.writeFileSync(process.env.DIRECTUS_BACKPORT_DESIRED!, JSON.stringify({ version: "11.17.4", ids: [B], updated: "" }));
			const result = await ensureDesiredApplied(t.install, t.catalog);
			assert.deepEqual(result.failed.map((item) => item.id), [B]);
		} finally {
			t.restore();
		}
	});
});

describe("rollback --snapshot", () => {
	it("keeps a later patch on the same file", async () => {
		const t = setup([insertion, second]);
		try {
			const first = await applyPatches(t.install, { ids: [A] }, t.catalog);
			await applyPatches(t.install, { ids: [B] }, t.catalog);
			rollbackSnapshot(t.install, first.snapshot!, t.catalog);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine.replace("const two = 2;", "const two = 22;"));
			assert.deepEqual(statusReport(t.install, t.catalog).appliedIds, [B]);
		} finally {
			t.restore();
		}
	});

	it("emergency rollback drops later patches honestly instead of leaving them recorded", async () => {
		const t = setup([insertion, second]);
		try {
			const first = await applyPatches(t.install, { ids: [A] }, t.catalog);
			await applyPatches(t.install, { ids: [B] }, t.catalog);
			const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "rollback.mjs");
			const run = spawnSync(process.execPath, [script, t.root, first.snapshot!], { encoding: "utf8" });
			assert.equal(run.status, 0, run.stderr);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
			assert.deepEqual(loadState(t.nodeModules).applied, []);
		} finally {
			t.restore();
		}
	});
});

describe("checksums", () => {
	it("refuses a file that merely contains the search text", async () => {
		const t = setup([insertion]);
		try {
			fs.appendFileSync(t.demo, "// a different build\n");
			const result = await applyPatches(t.install, { ids: [A] }, t.catalog);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /Checksum mismatch/);
			assert.ok(fs.readFileSync(t.demo, "utf8").endsWith("// a different build\n"));
			assert.ok(!fs.readFileSync(t.demo, "utf8").includes("guard"));
		} finally {
			t.restore();
		}
	});

	it("still stacks catalog patches on one file", async () => {
		const t = setup([insertion, second]);
		try {
			await applyPatches(t.install, { ids: [B] }, t.catalog);
			const result = await applyPatches(t.install, { ids: [A] }, t.catalog);
			assert.equal(result.ok, true);
		} finally {
			t.restore();
		}
	});
});

describe("catalog validation", () => {
	function withCatalog(mutate: (doc: any) => void) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-cat-"));
		const doc = { catalog_version: 1, advisories: [advisory(insertion)] };
		mutate(doc);
		fs.writeFileSync(path.join(dir, "advisories.yml"), stringifyYaml(doc));
		return dir;
	}

	for (const file of ["../../outside.txt", "express/index.js", "@directus/api/dist/../../../x.js", "@directus/api/package.json"]) {
		it(`rejects target ${file}`, () => {
			const dir = withCatalog((doc) => {
				doc.advisories[0].port.targets[0].file = file;
			});
			assert.throws(() => loadCatalog(dir), /dist file of an @directus package/);
		});
	}

	it("rejects a newer catalog format", () => {
		const dir = withCatalog((doc) => {
			doc.catalog_version = 2;
		});
		assert.throws(() => loadCatalog(dir), /not supported/);
	});

	it("rejects an unknown status", () => {
		const dir = withCatalog((doc) => {
			doc.advisories[0].port.status = "ship-it";
		});
		assert.throws(() => loadCatalog(dir), /unknown status/);
	});

	it("tracks port status per pin", () => {
		const dir = withCatalog((doc) => {
			doc.advisories[0].port.pins = { "11.17.4": "stable" };
		});
		const [item] = loadCatalog(dir).advisories;
		assert.equal(statusForVersion(item!, "11.17.4"), "stable");
		assert.equal(statusForVersion(item!, "10.13.4"), "experimental");
	});
});

describe("health", () => {
	it("does not call a ping healthy when nothing restarted", async () => {
		const t = setup([insertion]);
		try {
			// Port 1 is closed; a real check would fail and roll back.
			const result = await applyPatches(
				t.install,
				{ ids: [A], healthUrl: "http://127.0.0.1:1/server/ping", healthTimeoutMs: 100 },
				t.catalog,
			);
			assert.equal(result.ok, true);
			assert.equal(result.health, "pending");
		} finally {
			t.restore();
		}
	});
});

describe("preflight", () => {
	it("undoes an apply whose module throws on load", async () => {
		const t = setup([{ id: A, from: "const one = 1;", to: "const one = 1; throw new Error('boom');" }]);
		try {
			const result = await applyPatches(t.install, { ids: [A], preflight: true }, t.catalog);
			assert.equal(result.ok, false);
			assert.equal(result.rolledBack, true);
			assert.match(result.error ?? "", /did not load/);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
			assert.deepEqual(fs.existsSync(process.env.DIRECTUS_BACKPORT_DESIRED!), false);
		} finally {
			t.restore();
		}
	});

	it("undoes an apply that does not parse", async () => {
		const t = setup([{ id: A, from: "const one = 1;", to: "const one = 1;\nconst one = 2;" }]);
		try {
			const result = await applyPatches(t.install, { ids: [A], preflight: true }, t.catalog);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /does not parse/);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
		} finally {
			t.restore();
		}
	});

	it("boot re-apply keeps the good fix and names the bad one", async () => {
		const t = setup([insertion, { id: C, file: OTHER, from: "three = 3;", to: "three = 3; throw new Error('boom');" }]);
		try {
			fs.writeFileSync(process.env.DIRECTUS_BACKPORT_DESIRED!, JSON.stringify({ version: "11.17.4", ids: [A, C], updated: "" }));
			const result = await ensureDesiredApplied(t.install, t.catalog, { preflight: true });
			assert.deepEqual(result.applied, [A]);
			assert.deepEqual(result.failed.map((item) => item.id), [C]);
			assert.equal(fs.readFileSync(t.other, "utf8"), otherPristine);
			assert.deepEqual(statusReport(t.install, t.catalog).desired.ids.sort(), [A, C]);
		} finally {
			t.restore();
		}
	});
});

describe("boot guard", () => {
	it("rolls back after repeated boots that never reach server start", async () => {
		const t = setup([insertion]);
		try {
			await applyPatches(t.install, { ids: [A], guardBoot: true }, t.catalog);
			assert.deepEqual(noteBootStart(t.install, t.catalog, 3).rolledBack, []);
			assert.deepEqual(noteBootStart(t.install, t.catalog, 3).rolledBack, []);
			assert.deepEqual(noteBootStart(t.install, t.catalog, 3).rolledBack, [A]);
			assert.equal(fs.readFileSync(t.demo, "utf8"), pristine);
			assert.equal(loadState(t.nodeModules).pendingBoot, undefined);
			assert.match(loadState(t.nodeModules).last?.error ?? "", /did not start/);
		} finally {
			t.restore();
		}
	});

	it("stands down once Directus starts", async () => {
		const t = setup([insertion]);
		try {
			await applyPatches(t.install, { ids: [A], guardBoot: true }, t.catalog);
			noteBootStart(t.install, t.catalog, 3);
			noteBootHealthy(t.install);
			assert.equal(loadState(t.nodeModules).last?.health, "ok");
			for (let i = 0; i < 5; i += 1) noteBootStart(t.install, t.catalog, 3);
			assert.deepEqual(statusReport(t.install, t.catalog).appliedIds, [A]);
		} finally {
			t.restore();
		}
	});
});

describe("write ordering", () => {
	it("has the snapshot on disk before the patched bytes", async () => {
		const t = setup([insertion]);
		const rename = fs.renameSync;
		let snapshotSeen = false;
		(fs as { renameSync: typeof fs.renameSync }).renameSync = (from, to) => {
			const snapshots = path.join(t.root, ".directus-backport", "snapshots");
			const [dir] = fs.readdirSync(snapshots);
			snapshotSeen = fs.existsSync(path.join(snapshots, dir!, "manifest.json"));
			rename(from, to);
		};
		try {
			await applyPatches(t.install, { ids: [A] }, t.catalog);
			assert.equal(snapshotSeen, true);
		} finally {
			(fs as { renameSync: typeof fs.renameSync }).renameSync = rename;
			t.restore();
		}
	});
});
