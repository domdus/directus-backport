import fs from "node:fs";
import path from "node:path";
import type { Advisory, ApplyOptions, ApplyResult, DirectusInstall, HealthStatus } from "./types.js";
import { loadCatalog, partitionAdvisories, hasApplyablePatch, targetsForVersion } from "./catalog.js";
import { hasLocalCatalog, resolveCatalogDir } from "./catalog-source.js";
import { dataDir, ensureDir } from "./paths.js";
import { applyTarget, restoreMemory, restoreSnapshot, revertTarget, writeSnapshot, type SnapFile } from "./patch.js";
import { loadState, saveState } from "./state.js";
import { runCommand, waitForHealth } from "./health.js";
import { probeWriteAccess } from "./writable.js";
import { addDesiredIds, desiredPath, loadDesired, removeDesiredIds } from "./desired.js";

function snapshotId(): string {
	return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function resolveOptionalCatalogRoot(catalogRoot?: string): string | null {
	if (catalogRoot) return path.resolve(catalogRoot);
	if (hasLocalCatalog()) return resolveCatalogDir();
	return null;
}

export function statusReport(install: DirectusInstall, catalogRoot?: string) {
	const root = resolveOptionalCatalogRoot(catalogRoot);
	const state = loadState(install.nodeModules);
	const write = probeWriteAccess(install);
	const appliedIds = new Set(state.applied.map((a) => a.id));
	const lastApplied = state.applied.at(-1);
	const lastApplyIds = lastApplied ? [lastApplied.id] : [];

	if (!root) {
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
				applied: state.applied.length,
			},
			open: [] as Advisory[],
			ready: [] as Advisory[],
			waiting: [] as Advisory[],
			alreadyFixed: [] as Advisory[],
			applied: state.applied,
			appliedCatalog: [] as Advisory[],
			lastApplyIds,
			last: state.last,
			appliedIds: [...appliedIds],
			desired: loadDesired(undefined, state.desiredFile),
			desiredFile: state.desiredFile || desiredPath(),
		};
	}

	const catalog = loadCatalog(root);
	const parts = partitionAdvisories(catalog, install.version);
	const pending = parts.ready.filter((a) => !appliedIds.has(a.id));
	const catalogById = new Map(catalog.advisories.map((a) => [a.id, a]));
	const appliedCatalog = state.applied
		.map((row) => catalogById.get(row.id))
		.filter((a): a is Advisory => Boolean(a));
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
		lastApplyIds,
		last: state.last,
		appliedIds: [...appliedIds],
		desired: loadDesired(root, state.desiredFile),
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

function sortByCatalog(selected: Advisory[], catalogRoot?: string): Advisory[] {
	const catalog = loadCatalog(catalogRoot ? path.join(catalogRoot) : undefined);
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
		files.push(...restoreSnapshot(snapshotDirFor(install.nodeModules, row.snapshot)));
	}
	return files;
}

export async function applyPatches(
	install: DirectusInstall,
	options: ApplyOptions,
	catalogRoot?: string,
): Promise<ApplyResult> {
	const selected = sortByCatalog(pickAdvisories(install, options.ids, catalogRoot), catalogRoot);
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
			const these: SnapFile[] = [];
			for (const target of targetsForVersion(advisory, install.version)) {
				const snap = applyTarget(install.nodeModules, target);
				if (snap.skipped) continue;
				these.push(snap);
				changed.push(snap);
			}
			writeSnapshot(snapshotDir, these);
			files.push(...these.map((item) => item.file));
			perAdvisory.push({ advisory, snapId });
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
	let health: HealthStatus = options.healthUrl || options.restartCmd ? "pending" : "pending";
	state.last = { action: "apply", at, snapshot: snapId, ids: appliedIds, health };
	state.installVersion = install.version;
	state.desiredFile = state.desiredFile || desiredPath(catalogRoot);
	saveState(install.nodeModules, state);
	if (options.persistDesired !== false) {
		addDesiredIds(appliedIds, install.version, catalogRoot, state.desiredFile);
	}

	if (options.restartCmd) {
		try {
			await runCommand(options.restartCmd);
		} catch (err) {
			const error = `Restart command failed: ${err instanceof Error ? err.message : String(err)}`;
			if (options.rollbackOnFail !== false) {
				restoreMemory(changed);
				return finalizeRollback(install, appliedIds, snapId, files, error, catalogRoot);
			}
			return { ok: false, applied: appliedIds, snapshot: snapId, health: "failed", rolledBack: false, error, files };
		}
	}

	if (options.healthUrl) {
		const ok = await waitForHealth(options.healthUrl, options.healthTimeoutMs ?? 90_000);
		if (!ok) {
			const error = `Directus did not become healthy at ${options.healthUrl}`;
			if (options.rollbackOnFail !== false) {
				restoreMemory(changed);
				if (options.restartCmd) {
					try {
						await runCommand(options.restartCmd);
					} catch {
						/* already rolling back */
					}
				}
				return finalizeRollback(install, appliedIds, snapId, files, error, catalogRoot);
			}
			state.last = { ...state.last!, health: "failed", error };
			saveState(install.nodeModules, state);
			return { ok: false, applied: appliedIds, snapshot: snapId, health: "failed", rolledBack: false, error, files };
		}
		health = "ok";
		state.last = { ...state.last!, health: "ok" };
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
	const state = loadState(install.nodeModules);
	const last = state.applied.at(-1);
	if (!last) throw new Error("Nothing to rollback.");
	return rollbackOne(install, last.id, catalogRoot);
}

export function rollbackAll(install: DirectusInstall, catalogRoot?: string): { snapshot: string; files: string[] } {
	const state = loadState(install.nodeModules);
	const ids = state.applied.map((row) => row.id);
	if (ids.length === 0) throw new Error("Nothing to rollback.");
	return rollbackIds(install, ids, catalogRoot);
}

export function rollbackAdvisory(
	install: DirectusInstall,
	id: string,
	catalogRoot?: string,
): { snapshot: string; files: string[] } {
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
	const rows = unique
		.map((id) => state.applied.find((row) => row.id === id))
		.filter((row): row is NonNullable<typeof row> => Boolean(row));
	if (rows.length === 0) throw new Error("Nothing to rollback.");
	const files = restoreAppliedSnapshots(install, rows);
	state.applied = state.applied.filter((row) => !unique.includes(row.id));
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
	const catalog = loadCatalog(catalogRoot ? path.join(catalogRoot) : undefined);
	const advisory = catalog.advisories.find((item) => item.id === id);
	const reverted: SnapFile[] = [];
	let usedRevert = false;
	if (advisory) {
		try {
			for (const target of targetsForVersion(advisory, install.version)) {
				if (!files.has(target.file)) continue;
				const snap = revertTarget(install.nodeModules, target);
				if (!snap.skipped) reverted.push(snap);
			}
			usedRevert = true;
		} catch {
			restoreMemory(reverted);
		}
	}
	if (!usedRevert) {
		if (others.length === 0) {
			restoreSnapshot(snapshotDirFor(install.nodeModules, row.snapshot), files);
		} else {
			const touching = state.applied.filter((item) => item.files.some((file) => files.has(file)));
			const origin = touching[0];
			if (!origin) throw new Error(`${id} has no snapshot to restore.`);
			restoreSnapshot(snapshotDirFor(install.nodeModules, origin.snapshot), files);
			const byId = new Map(catalog.advisories.map((item) => [item.id, item]));
			for (const sibling of others) {
				const next = byId.get(sibling.id);
				if (!next) {
					throw new Error(`${sibling.id} is applied but missing from the catalog; cannot keep its patch.`);
				}
				for (const target of targetsForVersion(next, install.version)) {
					if (!files.has(target.file)) continue;
					applyTarget(install.nodeModules, target);
				}
			}
		}
	}
	state.applied = remaining;
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
	const files = restoreSnapshot(snapshotDir);
	const state = loadState(install.nodeModules);
	const removedIds = state.applied.filter((a) => a.snapshot === snapId).map((a) => a.id);
	state.applied = state.applied.filter((a) => a.snapshot !== snapId);
	state.last = {
		action: "rollback",
		at: new Date().toISOString(),
		snapshot: snapId,
		ids: removedIds.length ? removedIds : (state.last?.ids ?? []),
		health: "rolled-back",
	};
	saveState(install.nodeModules, state);
	removeDesiredIds(removedIds, catalogRoot, state.desiredFile);
	return { snapshot: snapId, files };
}

/**
 * Re-apply GHSA ids from desired.json when node_modules was reset (image recreate).
 * No-op when the list is empty, versions mismatch, or everything is already in state.
 */
export async function ensureDesiredApplied(install: DirectusInstall, catalogRoot?: string) {
	const state = loadState(install.nodeModules);
	const desired = loadDesired(catalogRoot, state.desiredFile);
	if (desired.ids.length === 0) {
		return { wrote: false, applied: [] as string[], skipped: true as const };
	}
	if (desired.version && desired.version !== install.version) {
		return {
			wrote: false,
			applied: [] as string[],
			skipped: true as const,
			error: `desired.json is pinned to Directus ${desired.version}, this install is ${install.version}`,
		};
	}
	const report = statusReport(install, catalogRoot);
	const wanted = new Set(desired.ids);
	const missing = report.ready.filter((a) => wanted.has(a.id)).map((a) => a.id);
	if (missing.length === 0) {
		return { wrote: false, applied: [] as string[], skipped: true as const };
	}
	const result = await applyPatches(
		install,
		{ ids: missing, rollbackOnFail: false, persistDesired: false },
		catalogRoot,
	);
	return {
		wrote: Boolean(result.ok && result.files.length > 0),
		applied: result.applied,
		skipped: false as const,
		ok: result.ok,
		error: result.error,
	};
}

export async function verifyInstall(install: DirectusInstall, healthUrl: string, timeoutMs = 30_000) {
	const ok = await waitForHealth(healthUrl, timeoutMs);
	const state = loadState(install.nodeModules);
	if (state.last) {
		state.last.health = ok ? "ok" : "failed";
		if (!ok) state.last.error = `Health check failed: ${healthUrl}`;
		saveState(install.nodeModules, state);
	}
	return { ok, last: state.last };
}
