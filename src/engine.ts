import fs from "node:fs";
import path from "node:path";
import type { Advisory, ApplyOptions, ApplyResult, AppliedPatch, Catalog, DirectusInstall, HealthStatus, ReapplyReport, StateFile } from "./types.js";
import { loadCatalog, partitionAdvisories, hasApplyablePatch, targetsForFile, targetsForVersion } from "./catalog.js";
import { hasLocalCatalog, remoteCatalogDir, resolveCatalogDir } from "./catalog-source.js";
import { dataDir, ensureDir } from "./paths.js";
import {
	commitPlan,
	planRevert,
	planTarget,
	restoreMemory,
	restoreSnapshot,
	peelPatches,
	sha256,
	writeSnapshot,
	type PlannedFile,
	type SnapFile,
} from "./patch.js";
import { resolveNodeFile } from "./detect.js";
import { loadState, saveState } from "./state.js";
import { runCommand, waitForHealth } from "./health.js";
import { preflightFiles } from "./preflight.js";
import { probeWriteAccess } from "./writable.js";
import { addDesiredIds, desiredPath, loadDesired, removeDesiredIds } from "./desired.js";
import { verifyCatalogDir } from "./trust.js";

function snapshotId(): string {
	return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function resolveOptionalCatalogRoot(catalogRoot?: string): string | null {
	if (catalogRoot) return path.resolve(catalogRoot);
	if (hasLocalCatalog()) return resolveCatalogDir();
	return null;
}

function tryLoadCatalog(catalogRoot?: string): Catalog | null {
	try {
		return loadCatalog(catalogRoot);
	} catch {
		return null;
	}
}

/** A downloaded catalog is code. It needs a valid signature every time it is applied. */
function assertCatalogTrusted(catalogRoot: string): void {
	let remote: string;
	try {
		remote = remoteCatalogDir();
	} catch {
		return;
	}
	if (path.resolve(catalogRoot) === path.resolve(remote)) verifyCatalogDir(catalogRoot);
}

function readTarget(nodeModules: string, file: string): string | null {
	try {
		return fs.readFileSync(resolveNodeFile(nodeModules, file), "utf8");
	} catch {
		return null;
	}
}

export type Drift = {
	/** Recorded as applied, but the patch is not in the files (node_modules was replaced). */
	missing: string[];
	/** In the files, but not recorded (state was removed). Rollback uses the catalog. */
	untracked: string[];
	/** Recorded, but the file changed in a way that neither proves nor disproves the patch. */
	unverified: string[];
};

/** Compare state.json with the bytes. The bytes win. Does not write. */
export function reconcileState(install: DirectusInstall, catalog: Catalog, state: StateFile): { state: StateFile; drift: Drift } {
	const byId = new Map(catalog.advisories.map((advisory) => [advisory.id, advisory]));
	const analysed = new Map<string, ReturnType<typeof peelPatches> | null>();
	const analyse = (file: string) => {
		if (!analysed.has(file)) {
			const content = readTarget(install.nodeModules, file);
			analysed.set(file, content === null ? null : peelPatches(content, targetsForFile(catalog, install.version, file)));
		}
		return analysed.get(file) ?? null;
	};
	const states = (advisory: Advisory) =>
		targetsForVersion(advisory, install.version).map((target) => {
			const found = analyse(target.file);
			if (!found) return "pending";
			if (found.peeled.includes(target)) return "applied";
			return sha256(found.base) === target.beforeSha256 ? "pending" : "conflict";
		});

	const drift: Drift = { missing: [], untracked: [], unverified: [] };
	const kept: AppliedPatch[] = [];
	for (const row of state.applied) {
		const advisory = byId.get(row.id);
		const replaced = Boolean(state.installVersion) && state.installVersion !== install.version;
		const found = advisory ? states(advisory) : [];
		if (replaced || (found.length > 0 && found.every((item) => item === "pending"))) {
			drift.missing.push(row.id);
			continue;
		}
		if (found.includes("conflict") && !found.every((item) => item === "applied")) {
			drift.unverified.push(row.id);
		}
		kept.push(row);
	}

	const known = new Set(kept.map((row) => row.id));
	for (const advisory of catalog.advisories) {
		if (known.has(advisory.id) || drift.missing.includes(advisory.id)) continue;
		const found = states(advisory);
		if (found.length === 0 || !found.every((item) => item === "applied")) continue;
		drift.untracked.push(advisory.id);
		kept.push({
			id: advisory.id,
			at: new Date().toISOString(),
			snapshot: "",
			files: targetsForVersion(advisory, install.version).map((target) => target.file),
		});
	}

	return { state: { ...state, applied: kept, installVersion: install.version }, drift };
}

function reconcileAndSave(install: DirectusInstall, catalog: Catalog | null): StateFile {
	const state = loadState(install.nodeModules);
	if (!catalog) return state;
	const { state: next, drift } = reconcileState(install, catalog, state);
	if (drift.missing.length || drift.untracked.length) saveState(install.nodeModules, next);
	return next;
}

export function statusReport(install: DirectusInstall, catalogRoot?: string) {
	const root = resolveOptionalCatalogRoot(catalogRoot);
	const recorded = loadState(install.nodeModules);
	const write = probeWriteAccess(install);

	if (!root) {
		const appliedIds = recorded.applied.map((a) => a.id);
		const last = recorded.applied.at(-1);
		return {
			install,
			write,
			catalogMissing: true as const,
			catalogSource: null,
			catalogUpdated: null,
			counts: {
				open: 0,
				ready: 0,
				waiting: 0,
				alreadyFixed: 0,
				applied: recorded.applied.length,
			},
			open: [] as Advisory[],
			ready: [] as Advisory[],
			waiting: [] as Advisory[],
			alreadyFixed: [] as Advisory[],
			applied: recorded.applied,
			appliedCatalog: [] as Advisory[],
			lastApplyIds: last ? [last.id] : [],
			last: recorded.last,
			appliedIds,
			drift: { missing: [], untracked: [], unverified: [] } as Drift,
			unprotected: [] as string[],
			lastReapply: recorded.lastReapply,
			pendingBoot: recorded.pendingBoot,
			desired: loadDesired(undefined, recorded.desiredFile),
			desiredFile: recorded.desiredFile || desiredPath(),
		};
	}

	const catalog = loadCatalog(root);
	const { state, drift } = reconcileState(install, catalog, recorded);
	const parts = partitionAdvisories(catalog, install.version);
	const appliedIds = new Set(state.applied.map((a) => a.id));
	const lastApplied = state.applied.at(-1);
	const pending = parts.ready.filter((a) => !appliedIds.has(a.id));
	const catalogById = new Map(catalog.advisories.map((a) => [a.id, a]));
	const appliedCatalog = state.applied
		.map((row) => catalogById.get(row.id))
		.filter((a): a is Advisory => Boolean(a));
	const desired = loadDesired(root, state.desiredFile);
	return {
		install,
		write,
		catalogMissing: false as const,
		catalogSource: catalog.source,
		catalogUpdated: catalog.updated,
		counts: {
			open: parts.open.length,
			ready: pending.length,
			waiting: parts.waiting.length,
			alreadyFixed: parts.alreadyFixed.length,
			applied: state.applied.length,
		},
		open: parts.open,
		ready: pending,
		waiting: parts.waiting,
		alreadyFixed: parts.alreadyFixed,
		applied: state.applied,
		appliedCatalog,
		lastApplyIds: lastApplied ? [lastApplied.id] : [],
		last: state.last,
		appliedIds: [...appliedIds],
		drift,
		/** Fixes the operator asked to keep that are not in the files right now. */
		unprotected: desired.ids.filter((id) => !appliedIds.has(id) || drift.unverified.includes(id)),
		lastReapply: state.lastReapply,
		pendingBoot: state.pendingBoot,
		desired,
		desiredFile: state.desiredFile || desiredPath(root),
	};
}

function pickAdvisories(install: DirectusInstall, ids: string[], catalogRoot?: string): Advisory[] {
	const report = statusReport(install, catalogRoot);
	const byId = new Map(report.open.concat(report.alreadyFixed).map((a) => [a.id, a]));
	const selected: Advisory[] = [];
	for (const id of ids) {
		const advisory = byId.get(id) ?? report.ready.concat(report.waiting).find((a) => a.id === id);
		if (!advisory) throw new Error(`Unknown advisory ${id}`);
		if (!hasApplyablePatch(advisory, install.version)) {
			throw new Error(`${id} has no applyable backport (status: ${advisory.port.status}).`);
		}
		if (report.appliedIds.includes(id)) {
			throw new Error(`${id} is already applied. Rollback first if you need to re-apply.`);
		}
		selected.push(advisory);
	}
	return selected;
}

function sortByCatalog(selected: Advisory[], catalog: Catalog): Advisory[] {
	const rank = new Map(catalog.advisories.map((advisory, index) => [advisory.id, index]));
	return [...selected].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

function snapshotDirFor(nodeModules: string, snapId: string): string {
	return path.join(dataDir(nodeModules), "snapshots", snapId);
}

function restoreAppliedSnapshots(install: DirectusInstall, rows: { snapshot: string }[]): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const row of [...rows].reverse()) {
		if (seen.has(row.snapshot)) continue;
		seen.add(row.snapshot);
		files.push(...restoreSnapshot(snapshotDirFor(install.nodeModules, row.snapshot), install.nodeModules));
	}
	return files;
}

/** Compute one advisory in memory so nothing is written until all of it is known to fit. */
function planAdvisory(install: DirectusInstall, advisory: Advisory, catalog: Catalog): PlannedFile[] {
	const plans: PlannedFile[] = [];
	const contents = new Map<string, string>();
	for (const target of targetsForVersion(advisory, install.version)) {
		const siblings = targetsForFile(catalog, install.version, target.file);
		const plan = planTarget(install.nodeModules, target, siblings, contents.get(target.file));
		if (plan.skipped) continue;
		plans.push(plan);
		contents.set(target.file, plan.next);
	}
	return plans;
}

export async function applyPatches(
	install: DirectusInstall,
	options: ApplyOptions,
	catalogRoot?: string,
): Promise<ApplyResult> {
	const root = catalogRoot ? path.resolve(catalogRoot) : resolveCatalogDir();
	assertCatalogTrusted(root);
	const catalog = loadCatalog(root);
	reconcileAndSave(install, catalog);
	const selected = sortByCatalog(pickAdvisories(install, options.ids, root), catalog);
	const write = probeWriteAccess(install);
	if (!write.writable) {
		return {
			ok: false,
			applied: [],
			health: "failed",
			rolledBack: false,
			error: write.reason || "node_modules is not writable",
			files: [],
		};
	}
	const changed: SnapFile[] = [];
	const files: string[] = [];
	const perAdvisory: { advisory: Advisory; snapId: string }[] = [];
	const batchStamp = snapshotId();

	try {
		for (const advisory of selected) {
			const snapId = `${batchStamp}-${advisory.id}`;
			const snapshotDir = snapshotDirFor(install.nodeModules, snapId);
			ensureDir(snapshotDir);
			const plans = planAdvisory(install, advisory, catalog);
			// The snapshot is complete on disk before the first patched byte is.
			writeSnapshot(snapshotDir, plans);
			for (const plan of plans) {
				commitPlan([plan]);
				changed.push(plan);
			}
			files.push(...plans.map((item) => item.file));
			perAdvisory.push({ advisory, snapId });
		}
		if (options.preflight && files.length) {
			await preflightFiles(install.root, [...new Set(files)]);
		}
	} catch (err) {
		restoreMemory(changed);
		const error = err instanceof Error ? err.message : String(err);
		const state = loadState(install.nodeModules);
		const snapId = perAdvisory.at(-1)?.snapId ?? `${batchStamp}-failed`;
		state.last = {
			action: "apply",
			at: new Date().toISOString(),
			snapshot: snapId,
			ids: options.ids,
			health: "rolled-back",
			error,
		};
		saveState(install.nodeModules, state);
		return {
			ok: false,
			applied: [],
			snapshot: snapId,
			health: "rolled-back",
			rolledBack: true,
			error,
			files: [],
		};
	}

	const state = loadState(install.nodeModules);
	const at = new Date().toISOString();
	const appliedIds = perAdvisory.map((row) => row.advisory.id);
	for (const row of perAdvisory) {
		state.applied.push({
			id: row.advisory.id,
			at,
			snapshot: row.snapId,
			files: targetsForVersion(row.advisory, install.version).map((target) => target.file),
		});
	}

	const snapId = perAdvisory.at(-1)?.snapId ?? batchStamp;
	let health: HealthStatus = "pending";
	state.last = { action: "apply", at, snapshot: snapId, ids: appliedIds, health };
	state.installVersion = install.version;
	state.desiredFile = state.desiredFile || desiredPath(root);
	if (options.guardBoot) {
		state.pendingBoot = {
			ids: [...new Set([...(state.pendingBoot?.ids ?? []), ...appliedIds])],
			at,
			boots: 0,
		};
	}
	saveState(install.nodeModules, state);
	if (options.persistDesired !== false) {
		addDesiredIds(appliedIds, install.version, root, state.desiredFile);
	}

	if (options.restartCmd) {
		try {
			await runCommand(options.restartCmd);
		} catch (err) {
			const error = `Restart command failed: ${err instanceof Error ? err.message : String(err)}`;
			if (options.rollbackOnFail !== false) {
				restoreMemory(changed);
				return finalizeRollback(install, appliedIds, snapId, files, error, root);
			}
			state.last = { ...state.last!, health: "failed", error };
			saveState(install.nodeModules, state);
			return { ok: false, applied: appliedIds, snapshot: snapId, health: "failed", rolledBack: false, error, files };
		}
	}

	// Without a restart the old process is still answering, with the old code loaded.
	// A ping then proves nothing, so the result stays pending until `verify`.
	if (options.healthUrl && options.restartCmd) {
		const ok = await waitForHealth(options.healthUrl, options.healthTimeoutMs ?? 90_000);
		if (!ok) {
			const error = `Directus did not become healthy at ${options.healthUrl}`;
			if (options.rollbackOnFail !== false) {
				restoreMemory(changed);
				try {
					await runCommand(options.restartCmd);
				} catch {
					/* already rolling back */
				}
				return finalizeRollback(install, appliedIds, snapId, files, error, root);
			}
			state.last = { ...state.last!, health: "failed", error };
			saveState(install.nodeModules, state);
			return { ok: false, applied: appliedIds, snapshot: snapId, health: "failed", rolledBack: false, error, files };
		}
		health = "ok";
		state.last = { ...state.last!, health: "ok" };
		delete state.pendingBoot;
		saveState(install.nodeModules, state);
	}

	return {
		ok: true,
		applied: appliedIds,
		snapshot: snapId,
		health,
		rolledBack: false,
		files,
	};
}

function finalizeRollback(
	install: DirectusInstall,
	ids: string[],
	snapId: string,
	files: string[],
	error: string,
	catalogRoot?: string,
): ApplyResult {
	const state = loadState(install.nodeModules);
	state.applied = state.applied.filter((a) => !ids.includes(a.id));
	delete state.pendingBoot;
	state.last = {
		action: "rollback",
		at: new Date().toISOString(),
		snapshot: snapId,
		ids,
		health: "rolled-back",
		error,
	};
	saveState(install.nodeModules, state);
	removeDesiredIds(ids, catalogRoot, state.desiredFile);
	return {
		ok: false,
		applied: [],
		snapshot: snapId,
		health: "rolled-back",
		rolledBack: true,
		error,
		files,
	};
}

export function rollbackLast(install: DirectusInstall, catalogRoot?: string): { snapshot: string; files: string[] } {
	const state = reconcileAndSave(install, tryLoadCatalog(catalogRoot));
	const last = state.applied.at(-1);
	if (!last) throw new Error("Nothing to rollback.");
	return rollbackOne(install, last.id, catalogRoot);
}

export function rollbackAll(install: DirectusInstall, catalogRoot?: string): { snapshot: string; files: string[] } {
	const state = reconcileAndSave(install, tryLoadCatalog(catalogRoot));
	const ids = state.applied.map((row) => row.id);
	if (ids.length === 0) throw new Error("Nothing to rollback.");
	return rollbackIds(install, ids, catalogRoot);
}

export function rollbackAdvisory(
	install: DirectusInstall,
	id: string,
	catalogRoot?: string,
): { snapshot: string; files: string[] } {
	reconcileAndSave(install, tryLoadCatalog(catalogRoot));
	return rollbackIds(install, [id], catalogRoot);
}

export function rollbackIds(
	install: DirectusInstall,
	ids: string[],
	catalogRoot?: string,
): { snapshot: string; files: string[] } {
	const unique = [...new Set(ids)];
	if (unique.length === 1) {
		return rollbackOne(install, unique[0]!, catalogRoot);
	}
	const state = loadState(install.nodeModules);
	const rows = state.applied.filter((row) => unique.includes(row.id));
	if (rows.length === 0) throw new Error("Nothing to rollback.");

	// Snapshots stack, so restoring newest-first is only safe when nothing stays applied.
	const everything = rows.length === state.applied.length;
	if (!everything || rows.some((row) => !row.snapshot)) {
		const files = new Set<string>();
		let snapshot = "";
		for (const row of [...rows].reverse()) {
			const result = rollbackOne(install, row.id, catalogRoot);
			result.files.forEach((file) => files.add(file));
			snapshot = result.snapshot || snapshot;
		}
		return { snapshot, files: [...files] };
	}

	const files = restoreAppliedSnapshots(install, rows);
	state.applied = state.applied.filter((row) => !unique.includes(row.id));
	if (state.pendingBoot) {
		state.pendingBoot.ids = state.pendingBoot.ids.filter((id) => !unique.includes(id));
		if (!state.pendingBoot.ids.length) delete state.pendingBoot;
	}
	const snapId = rows.at(-1)?.snapshot ?? state.last?.snapshot ?? "";
	state.last = {
		action: "rollback",
		at: new Date().toISOString(),
		snapshot: snapId,
		ids: unique,
		health: "rolled-back",
	};
	saveState(install.nodeModules, state);
	removeDesiredIds(unique, catalogRoot, state.desiredFile);
	return { snapshot: snapId, files };
}

/** Undo one advisory from the catalog text, verifying the result before anything is written. */
function planRollback(install: DirectusInstall, catalog: Catalog, advisory: Advisory, files: Set<string>): PlannedFile[] {
	const targets = targetsForVersion(advisory, install.version).filter((target) => files.has(target.file));
	const covered = new Set(targets.map((target) => target.file));
	if ([...files].some((file) => !covered.has(file))) {
		throw new Error(`${advisory.id} changed since it was applied`);
	}
	const plans: PlannedFile[] = [];
	const contents = new Map<string, string>();
	for (const target of targets) {
		const siblings = targetsForFile(catalog, install.version, target.file);
		const plan = planRevert(install.nodeModules, target, siblings, contents.get(target.file));
		if (!plan) continue;
		plans.push(plan);
		contents.set(target.file, plan.next);
	}
	return plans;
}

function assertReverted(install: DirectusInstall, catalog: Catalog, advisory: Advisory, files: Set<string>): void {
	for (const target of targetsForVersion(advisory, install.version)) {
		if (!files.has(target.file)) continue;
		const content = fs.readFileSync(resolveNodeFile(install.nodeModules, target.file), "utf8");
		const { base, peeled } = peelPatches(content, targetsForFile(catalog, install.version, target.file));
		if (peeled.includes(target) || sha256(base) !== target.beforeSha256) {
			throw new Error(`Rollback of ${advisory.id} left ${target.file} different from the pinned build.`);
		}
	}
}

function rollbackOne(
	install: DirectusInstall,
	id: string,
	catalogRoot?: string,
): { snapshot: string; files: string[] } {
	const state = loadState(install.nodeModules);
	const row = state.applied.find((item) => item.id === id);
	if (!row) throw new Error(`${id} is not applied.`);
	const files = new Set(row.files);
	const remaining = state.applied.filter((item) => item.id !== id);
	const others = remaining.filter((item) => item.files.some((file) => files.has(file)));
	const catalog = tryLoadCatalog(catalogRoot);
	const advisory = catalog?.advisories.find((item) => item.id === id);
	let reverted = false;
	if (catalog && advisory) {
		try {
			commitPlan(planRollback(install, catalog, advisory, files));
			reverted = true;
		} catch {
			reverted = false;
		}
	}
	if (!reverted) {
		if (others.length === 0) {
			if (!row.snapshot) throw new Error(`${id} has no snapshot, and the catalog cannot undo it.`);
			restoreSnapshot(snapshotDirFor(install.nodeModules, row.snapshot), install.nodeModules, files);
		} else {
			const touching = state.applied.filter((item) => item.snapshot && item.files.some((file) => files.has(file)));
			const origin = touching[0];
			if (!origin) throw new Error(`${id} has no snapshot to restore.`);
			if (!catalog) throw new Error(`${id} shares files with other backports. Restoring it needs the catalog.`);
			restoreSnapshot(snapshotDirFor(install.nodeModules, origin.snapshot), install.nodeModules, files);
			const byId = new Map(catalog.advisories.map((item) => [item.id, item]));
			for (const sibling of others) {
				const next = byId.get(sibling.id);
				if (!next) {
					throw new Error(`${sibling.id} is applied but missing from the catalog; cannot keep its patch.`);
				}
				const plans = planAdvisory(install, next, catalog).filter((plan) => files.has(plan.rel));
				commitPlan(plans);
			}
		}
	}
	if (catalog && advisory) {
		assertReverted(install, catalog, advisory, files);
	}
	state.applied = remaining;
	if (state.pendingBoot) {
		state.pendingBoot.ids = state.pendingBoot.ids.filter((item) => item !== id);
		if (!state.pendingBoot.ids.length) delete state.pendingBoot;
	}
	state.last = {
		action: "rollback",
		at: new Date().toISOString(),
		snapshot: row.snapshot,
		ids: [id],
		health: "rolled-back",
	};
	saveState(install.nodeModules, state);
	removeDesiredIds([id], catalogRoot, state.desiredFile);
	return { snapshot: row.snapshot, files: [...files] };
}

export function rollbackSnapshot(
	install: DirectusInstall,
	snapId: string,
	catalogRoot?: string,
): { snapshot: string; files: string[] } {
	const snapshotDir = snapshotDirFor(install.nodeModules, snapId);
	if (!fs.existsSync(snapshotDir)) {
		throw new Error(`Snapshot ${snapId} not found at ${snapshotDir}`);
	}
	const state = reconcileAndSave(install, tryLoadCatalog(catalogRoot));
	const rows = state.applied.filter((row) => row.snapshot === snapId);
	if (rows.length) {
		// Goes through the per-advisory path so later patches on the same file survive.
		return { ...rollbackIds(install, rows.map((row) => row.id), catalogRoot), snapshot: snapId };
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8")) as {
		files: { rel: string }[];
	};
	const rels = new Set(manifest.files.map((item) => item.rel));
	const blocking = state.applied.filter((row) => row.files.some((file) => rels.has(file)));
	if (blocking.length) {
		throw new Error(
			`Snapshot ${snapId} would remove ${blocking.map((row) => row.id).join(", ")}. Roll those back first.`,
		);
	}
	const files = restoreSnapshot(snapshotDir, install.nodeModules);
	state.last = {
		action: "rollback",
		at: new Date().toISOString(),
		snapshot: snapId,
		ids: state.last?.ids ?? [],
		health: "rolled-back",
	};
	saveState(install.nodeModules, state);
	return { snapshot: snapId, files };
}

export type EnsureOptions = { preflight?: boolean; guardBoot?: boolean };

/**
 * Re-apply GHSA ids from desired.json when node_modules was reset (image recreate).
 * Each advisory stands alone: one that cannot apply must not leave the others off.
 * No-op when the list is empty, versions mismatch, or everything is already in the files.
 */
export async function ensureDesiredApplied(install: DirectusInstall, catalogRoot?: string, options: EnsureOptions = {}) {
	const root = catalogRoot ? path.resolve(catalogRoot) : resolveCatalogDir();
	const state = reconcileAndSave(install, tryLoadCatalog(root));
	const desired = loadDesired(root, state.desiredFile);
	if (desired.ids.length === 0) {
		return { wrote: false, applied: [] as string[], failed: [] as ReapplyReport["failed"], skipped: true as const };
	}
	if (desired.version && desired.version !== install.version) {
		return {
			wrote: false,
			applied: [] as string[],
			failed: [] as ReapplyReport["failed"],
			skipped: true as const,
			error: `desired.json is pinned to Directus ${desired.version}, this install is ${install.version}`,
		};
	}
	const report = statusReport(install, root);
	const wanted = new Set(desired.ids);
	const ready = report.ready.filter((a) => wanted.has(a.id)).map((a) => a.id);
	const failed: ReapplyReport["failed"] = report.unprotected
		.filter((id) => !ready.includes(id))
		.map((id) => ({
			id,
			error: report.drift.unverified.includes(id)
				? "The patched file changed, so this fix cannot be confirmed"
				: `No backport for Directus ${install.version} in the current catalog`,
		}));
	if (ready.length === 0 && failed.length === 0) {
		return { wrote: false, applied: [] as string[], failed, skipped: true as const };
	}

	const applyEach = async (ids: string[], preflight: boolean) => {
		const done: string[] = [];
		for (const id of ids) {
			try {
				const result = await applyPatches(
					install,
					{ ids: [id], rollbackOnFail: false, persistDesired: false, guardBoot: options.guardBoot, preflight },
					root,
				);
				if (result.ok) done.push(id);
				else failed.push({ id, error: result.error || "Apply failed" });
			} catch (err) {
				failed.push({ id, error: err instanceof Error ? err.message : String(err) });
			}
		}
		return done;
	};

	let applied = await applyEach(ready, false);
	if (options.preflight && applied.length) {
		const changed = [...new Set(applied.flatMap((id) => {
			const advisory = report.ready.find((item) => item.id === id);
			return advisory ? targetsForVersion(advisory, install.version).map((t) => resolveNodeFile(install.nodeModules, t.file)) : [];
		}))];
		try {
			await preflightFiles(install.root, changed);
		} catch {
			// One of them is bad. Take the slow path to keep the good ones and name the bad one.
			for (const id of [...applied].reverse()) rollbackForRetry(install, id, root);
			applied = await applyEach(applied, true);
		}
	}

	const after = loadState(install.nodeModules);
	const reapply: ReapplyReport = { at: new Date().toISOString(), applied, failed };
	after.lastReapply = reapply;
	saveState(install.nodeModules, after);

	return {
		wrote: applied.length > 0,
		applied,
		failed,
		skipped: false as const,
		ok: failed.length === 0,
		error: failed.length ? failed.map((item) => `${item.id}: ${item.error.split("\n")[0]}`).join("; ") : undefined,
	};
}

/** Roll back for a retry without dropping the id from desired.json. */
function rollbackForRetry(install: DirectusInstall, id: string, catalogRoot: string): void {
	const desired = loadDesired(catalogRoot, loadState(install.nodeModules).desiredFile);
	rollbackOne(install, id, catalogRoot);
	if (desired.ids.includes(id)) {
		addDesiredIds([id], desired.version, catalogRoot, loadState(install.nodeModules).desiredFile);
	}
}

/**
 * Called from the boot hook. A Directus that dies after loading extensions but before
 * listening never reaches noteBootHealthy, so the count climbs until it rolls back.
 */
export function noteBootStart(install: DirectusInstall, catalogRoot: string | undefined, limit = 3): { rolledBack: string[] } {
	const state = loadState(install.nodeModules);
	if (!state.pendingBoot) return { rolledBack: [] };
	state.pendingBoot.boots += 1;
	if (state.pendingBoot.boots < limit) {
		saveState(install.nodeModules, state);
		return { rolledBack: [] };
	}
	const ids = state.pendingBoot.ids.filter((id) => state.applied.some((row) => row.id === id));
	delete state.pendingBoot;
	saveState(install.nodeModules, state);
	if (ids.length) rollbackIds(install, ids, catalogRoot);
	const after = loadState(install.nodeModules);
	if (after.last) {
		after.last.error = `Directus did not start after ${limit} attempts with these backports. They were rolled back.`;
		saveState(install.nodeModules, after);
	}
	return { rolledBack: ids };
}

/** Directus is listening with the patched code loaded. */
export function noteBootHealthy(install: DirectusInstall): void {
	const state = loadState(install.nodeModules);
	if (!state.pendingBoot) return;
	delete state.pendingBoot;
	if (state.last?.action === "apply") state.last.health = "ok";
	saveState(install.nodeModules, state);
}

export async function verifyInstall(install: DirectusInstall, healthUrl: string, timeoutMs = 30_000) {
	const ok = await waitForHealth(healthUrl, timeoutMs);
	const state = loadState(install.nodeModules);
	if (state.last) {
		state.last.health = ok ? "ok" : "failed";
		if (!ok) state.last.error = `Health check failed: ${healthUrl}`;
		if (ok) delete state.pendingBoot;
		saveState(install.nodeModules, state);
	}
	return { ok, last: state.last };
}
