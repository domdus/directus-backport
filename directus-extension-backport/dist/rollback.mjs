#!/usr/bin/env node
/**
 * Zero-dependency emergency rollback.
 * Works when Directus will not boot. The install folder is discovered from
 * cwd, this file, or /directus — you do not pass --root.
 *
 *   node /directus/extensions/directus-extension-backport/dist/rollback.mjs
 *   node /directus/extensions/directus-extension-backport/dist/rollback.mjs all
 *
 *   docker compose run --no-deps --entrypoint node directus \
 *     /directus/extensions/directus-extension-backport/dist/rollback.mjs
 *
 * Advanced: pass an install folder if this file is not next to Directus.
 * Optional trailing snapshot id.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const wantAll = args.includes("all") || args.includes("--all");
const rest = args.filter((a) => a !== "all" && a !== "--all" && a !== "--");

function isDirectory(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function stateFileAt(dir) {
	return path.join(dir, ".directus-backport", "state.json");
}

function walkState(start) {
	let dir = path.resolve(start);
	while (true) {
		if (fs.existsSync(stateFileAt(dir))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

let explicitRoot;
let snapId = "";
for (const a of rest) {
	const resolved = path.resolve(a);
	if (isDirectory(resolved)) explicitRoot = resolved;
	else snapId = a;
}

const hints = [explicitRoot, process.cwd(), here, path.resolve(here, "..", ".."), "/directus"].filter(
	(value) => typeof value === "string" && value.length > 0,
);

let root = null;
for (const hint of hints) {
	root = walkState(hint);
	if (root) break;
}

if (!root) {
	console.error(
		`No .directus-backport/state.json found. Run this from the Directus folder, or pass that folder as an argument.`,
	);
	process.exit(1);
}

const dataDir = path.join(root, ".directus-backport");
const stateFile = stateFileAt(root);

const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

function fileFor(item) {
	// Absolute paths differ between a container and the host it is mounted from.
	const local = path.join(root, "node_modules", item.rel);
	return fs.existsSync(local) ? local : item.original;
}

function manifestOf(id) {
	const manifestFile = path.join(dataDir, "snapshots", id, "manifest.json");
	if (!id || !fs.existsSync(manifestFile)) return null;
	return JSON.parse(fs.readFileSync(manifestFile, "utf8"));
}

/** Check everything first: stopping halfway would leave files and state.json disagreeing. */
function requireSnapshots(rows) {
	const missing = rows.filter((row) => !manifestOf(row.snapshot));
	if (!missing.length) return;
	console.error(
		`No snapshot for ${missing.map((row) => row.id).join(", ")}. Use cli.mjs rollback, which can undo these from the catalog.`,
	);
	process.exit(1);
}

function restoreSnap(id) {
	const snapshotDir = path.join(dataDir, "snapshots", id);
	const manifest = manifestOf(id);
	if (!manifest) {
		console.error(`Snapshot missing: ${snapshotDir}`);
		process.exit(1);
	}
	let n = 0;
	for (const item of manifest.files || []) {
		const snap = path.join(snapshotDir, "files", item.rel);
		if (!fs.existsSync(snap)) {
			console.error(`Missing snapshot copy: ${item.rel}`);
			process.exit(1);
		}
		const dest = fileFor(item);
		const tmp = `${dest}.backport-${process.pid}.tmp`;
		fs.copyFileSync(snap, tmp);
		fs.chmodSync(tmp, fs.statSync(dest).mode);
		fs.renameSync(tmp, dest);
		n += 1;
	}
	return n;
}

let count = 0;
let removedIds = [];
let restoredId = snapId;

if (wantAll) {
	const rows = [...(state.applied || [])];
	requireSnapshots(rows);
	removedIds = rows.map((row) => row.id);
	const seen = new Set();
	for (const row of rows.reverse()) {
		if (seen.has(row.snapshot)) continue;
		seen.add(row.snapshot);
		count += restoreSnap(row.snapshot);
		restoredId = row.snapshot;
	}
	state.applied = [];
} else if (snapId) {
	// A snapshot also predates every later patch on its files, so those go with it.
	const rows = state.applied || [];
	const start = rows.findIndex((row) => row.snapshot === snapId);
	const chain = start < 0 ? [] : rows.slice(start).filter((row) => row.snapshot === snapId);
	if (start >= 0) {
		const files = new Set(chain.flatMap((row) => row.files || []));
		for (const row of rows.slice(start)) {
			if (chain.includes(row) || !(row.files || []).some((file) => files.has(file))) continue;
			chain.push(row);
			(row.files || []).forEach((file) => files.add(file));
		}
	}
	requireSnapshots(chain);
	restoredId = snapId;
	const order = chain.length ? chain.map((row) => row.snapshot) : [snapId];
	for (const id of [...new Set(order)].reverse()) count += restoreSnap(id);
	removedIds = chain.map((row) => row.id);
	state.applied = rows.filter((row) => !chain.includes(row));
	const extra = removedIds.filter((id, index) => chain[index].snapshot !== snapId);
	if (extra.length) console.log(`also removed, they shared files: ${extra.join(", ")}`);
} else {
	const last = (state.applied || []).at(-1);
	if (!last) {
		console.error("Nothing to rollback.");
		process.exit(1);
	}
	requireSnapshots([last]);
	restoredId = last.snapshot;
	count = restoreSnap(last.snapshot);
	removedIds = [last.id];
	state.applied = (state.applied || []).filter((row) => row.id !== last.id);
}
delete state.pendingBoot;
state.last = {
	action: "rollback",
	at: new Date().toISOString(),
	snapshot: restoredId,
	ids: removedIds.length ? removedIds : state.last?.ids || [],
	health: "rolled-back",
};
fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

const desiredFile =
	(state.desiredFile && fs.existsSync(state.desiredFile) && state.desiredFile) ||
	path.join(here, "..", "desired.json");
if (fs.existsSync(desiredFile) && removedIds.length) {
	try {
		const desired = JSON.parse(fs.readFileSync(desiredFile, "utf8"));
		const drop = new Set(removedIds);
		desired.ids = (desired.ids || []).filter((id) => !drop.has(id));
		desired.updated = new Date().toISOString();
		fs.writeFileSync(desiredFile, `${JSON.stringify(desired, null, 2)}\n`);
	} catch (err) {
		console.error(`Could not update ${desiredFile}: ${err instanceof Error ? err.message : err}`);
	}
}

console.log(`restored snapshot ${restoredId} (${count} files)`);
