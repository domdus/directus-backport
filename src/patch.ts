import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { PatchTarget, Replacement } from "./types.js";
import { resolveNodeFile } from "./detect.js";

export function sha256(contents: string | Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

export type SnapFile = { file: string; previous: string; rel: string; skipped?: boolean };

/** A computed change that has not touched the disk yet. */
export type PlannedFile = SnapFile & { next: string };

export type TargetState = "applied" | "pending" | "conflict";

function opApplied(content: string, op: Replacement): boolean {
	if (op.from === op.to) return content.includes(op.to);
	// Insertions keep `from` inside `to`, so `from` staying visible proves nothing.
	if (op.to.includes(op.from)) return content.includes(op.to);
	return content.includes(op.to) && !content.includes(op.from);
}

function opPending(content: string, op: Replacement): boolean {
	return content.includes(op.from) && !opApplied(content, op);
}

/** What the bytes say about one target. This is the only source of truth for "applied". */
export function targetState(content: string, target: PatchTarget): TargetState {
	if (!target.replace?.length) {
		const actual = sha256(content);
		if (target.afterSha256 && actual === target.afterSha256) return "applied";
		return actual === target.beforeSha256 ? "pending" : "conflict";
	}
	if (target.replace.every((op) => opApplied(content, op))) return "applied";
	if (target.replace.every((op) => opPending(content, op))) return "pending";
	return "conflict";
}

function forward(content: string, target: PatchTarget): string {
	let next = content;
	for (const op of target.replace ?? []) {
		if (!next.includes(op.from)) {
			throw new Error(`Replacement did not match in ${target.file}: ${op.from.slice(0, 80)}`);
		}
		next = next.split(op.from).join(op.to);
	}
	if (target.diff) {
		const patches = parsePatch(target.diff);
		if (patches.length === 0) throw new Error(`Empty unified diff for ${target.file}`);
		const patched = applyPatch(next, patches[0]!);
		if (patched === false) throw new Error(`Unified diff did not apply to ${target.file}`);
		next = patched;
	}
	return next;
}

function backward(content: string, target: PatchTarget): string {
	let next = content;
	for (const op of [...(target.replace ?? [])].reverse()) {
		next = next.split(op.to).join(op.from);
	}
	return next;
}

/**
 * Take known patches off in memory, newest layer first. A patch whose code was
 * edited by a later one only becomes visible once that later one is gone, which
 * is why this loops. `base` hashes to before_sha256 only when the file is the
 * pinned build plus nothing but catalog patches.
 */
export function peelPatches(content: string, siblings: PatchTarget[]): { base: string; peeled: PatchTarget[] } {
	let base = content;
	const peeled: PatchTarget[] = [];
	const remaining = siblings.filter((target) => target.replace?.length && !target.diff);
	for (let progress = true; progress; ) {
		progress = false;
		for (const target of [...remaining]) {
			if (targetState(base, target) !== "applied") continue;
			base = backward(base, target);
			peeled.push(target);
			remaining.splice(remaining.indexOf(target), 1);
			progress = true;
		}
	}
	return { base, peeled };
}

function checksumError(target: PatchTarget, actual: string): Error {
	return new Error(
		`Checksum mismatch for ${target.file}.\nExpected ${target.beforeSha256}\nActual   ${actual}\nThis patch is pinned to a specific Directus build — refusing to apply.`,
	);
}

/** Work out a change without writing. `content` overrides the disk for multi-target advisories. */
export function planTarget(
	nodeModules: string,
	target: PatchTarget,
	siblings: PatchTarget[] = [target],
	content?: string,
): PlannedFile {
	const file = resolveNodeFile(nodeModules, target.file);
	const previous = content ?? fs.readFileSync(file, "utf8");
	const { base: baseline, peeled } = peelPatches(previous, siblings);
	if (peeled.includes(target) || targetState(previous, target) === "applied") {
		return { file, previous, next: previous, rel: target.file, skipped: true };
	}
	const actual = sha256(baseline);
	if (actual !== target.beforeSha256) throw checksumError(target, actual);
	if (targetState(previous, target) !== "pending") {
		throw new Error(`Patch for ${target.file} conflicts with another change to the same code.`);
	}

	const next = forward(previous, target);
	if (next === previous) throw new Error(`Patch for ${target.file} made no changes`);
	if (target.afterSha256 && sha256(forward(baseline, target)) !== target.afterSha256) {
		throw new Error(`After-checksum mismatch for ${target.file}`);
	}
	return { file, previous, next, rel: target.file };
}

/** Work out a revert without writing. Returns null when the patch is not in the bytes. */
export function planRevert(
	nodeModules: string,
	target: PatchTarget,
	siblings: PatchTarget[] = [target],
	content?: string,
): PlannedFile | null {
	if (!target.replace?.length) {
		throw new Error(`Cannot revert ${target.file} without replacement operations`);
	}
	const file = resolveNodeFile(nodeModules, target.file);
	const previous = content ?? fs.readFileSync(file, "utf8");
	const { base, peeled } = peelPatches(previous, siblings);
	if (sha256(base) !== target.beforeSha256) {
		throw new Error(`Cannot revert ${target.file}: the file does not match the pinned build`);
	}
	if (!peeled.includes(target)) return null;
	// Rebuild from the pinned bytes so the result is exactly the patches that stay.
	const next = [...peeled]
		.reverse()
		.filter((item) => item !== target)
		.reduce((text, item) => forward(text, item), base);
	return { file, previous, next, rel: target.file };
}

/** Replace a file in one step so a crash cannot leave half a module behind. */
export function writeFileAtomic(file: string, contents: string): void {
	const stat = fs.statSync(file);
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.backport-${process.pid}.tmp`);
	try {
		fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: stat.mode });
	} catch (err) {
		// Some images allow writing the file but not creating siblings next to it.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw err;
		fs.writeFileSync(file, contents, "utf8");
		return;
	}
	try {
		try {
			fs.chownSync(tmp, stat.uid, stat.gid);
		} catch {
			/* only root can give files away; the mode above is still preserved */
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

export function commitPlan(plans: PlannedFile[]): void {
	for (const plan of plans) writeFileAtomic(plan.file, plan.next);
}

export function restoreMemory(files: SnapFile[]): void {
	for (const item of [...files].reverse()) {
		writeFileAtomic(item.file, item.previous);
	}
}

type Manifest = {
	files: { original: string; rel: string }[];
};

export function writeSnapshot(snapshotDir: string, files: SnapFile[]): void {
	fs.mkdirSync(snapshotDir, { recursive: true });
	const manifest: Manifest = { files: [] };
	const seen = new Set<string>();
	for (const item of files) {
		// The earliest copy in a batch is the one that holds the pre-patch bytes.
		if (seen.has(item.rel)) continue;
		seen.add(item.rel);
		const dest = path.join(snapshotDir, "files", item.rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, item.previous, "utf8");
		manifest.files.push({ original: item.file, rel: item.rel });
	}
	fs.writeFileSync(path.join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function restoreSnapshot(snapshotDir: string, nodeModules: string, onlyRels?: Iterable<string>): string[] {
	const manifestFile = path.join(snapshotDir, "manifest.json");
	if (!fs.existsSync(manifestFile)) {
		throw new Error(`Snapshot missing: ${snapshotDir}`);
	}
	const allow = onlyRels ? new Set(onlyRels) : null;
	const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
	const restored: string[] = [];
	for (const item of manifest.files) {
		if (allow && !allow.has(item.rel)) continue;
		const snap = path.join(snapshotDir, "files", item.rel);
		if (!fs.existsSync(snap)) throw new Error(`Snapshot file missing: ${item.rel}`);
		// Absolute paths differ between a container and the host it is mounted from.
		const target = resolveNodeFile(nodeModules, item.rel);
		writeFileAtomic(target, fs.readFileSync(snap, "utf8"));
		restored.push(target);
	}
	return restored;
}
