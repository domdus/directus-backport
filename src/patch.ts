import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { PatchTarget } from "./types.js";
import { resolveNodeFile } from "./detect.js";

export function sha256(contents: string | Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

export type SnapFile = { file: string; previous: string; rel: string; skipped?: boolean };

function replacementsReady(previous: string, target: PatchTarget): boolean {
	return Boolean(target.replace?.length) && target.replace!.every((op) => previous.includes(op.from));
}

function alreadyApplied(previous: string, target: PatchTarget): boolean {
	if (!target.replace?.length) return false;
	return target.replace.every((op) => previous.includes(op.to) && (op.from === op.to || !previous.includes(op.from)));
}

export function applyTarget(nodeModules: string, target: PatchTarget): SnapFile {
	const file = resolveNodeFile(nodeModules, target.file);
	const previous = fs.readFileSync(file, "utf8");
	const actual = sha256(previous);
	const pinned = actual === target.beforeSha256;

	if (!pinned) {
		if (alreadyApplied(previous, target)) {
			return { file, previous, rel: target.file, skipped: true };
		}
		if (!replacementsReady(previous, target)) {
			throw new Error(
				`Checksum mismatch for ${target.file}.\nExpected ${target.beforeSha256}\nActual   ${actual}\nThis patch is pinned to a specific Directus build — refusing to apply.`,
			);
		}
	}

	let next = previous;
	if (target.replace?.length) {
		for (const op of target.replace) {
			if (!next.includes(op.from)) {
				throw new Error(`Replacement did not match in ${target.file}: ${op.from.slice(0, 80)}`);
			}
			next = next.split(op.from).join(op.to);
		}
	}
	if (target.diff) {
		const patches = parsePatch(target.diff);
		if (patches.length === 0) {
			throw new Error(`Empty unified diff for ${target.file}`);
		}
		const patched = applyPatch(next, patches[0]!);
		if (patched === false) {
			throw new Error(`Unified diff did not apply to ${target.file}`);
		}
		next = patched;
	}

	if (next === previous) {
		if (alreadyApplied(previous, target)) {
			return { file, previous, rel: target.file, skipped: true };
		}
		throw new Error(`Patch for ${target.file} made no changes`);
	}
	if (pinned && target.afterSha256 && sha256(next) !== target.afterSha256) {
		throw new Error(`After-checksum mismatch for ${target.file}`);
	}

	fs.writeFileSync(file, next, "utf8");
	return { file, previous, rel: target.file };
}

export function revertTarget(nodeModules: string, target: PatchTarget): SnapFile {
	if (!target.replace?.length) {
		throw new Error(`Cannot revert ${target.file} without replacement operations`);
	}
	const file = resolveNodeFile(nodeModules, target.file);
	const previous = fs.readFileSync(file, "utf8");
	if (!alreadyApplied(previous, target)) {
		if (replacementsReady(previous, target)) {
			return { file, previous, rel: target.file, skipped: true };
		}
		throw new Error(`Cannot revert ${target.file}: patched bytes were not found`);
	}
	let next = previous;
	for (const op of [...target.replace].reverse()) {
		if (!next.includes(op.to)) {
			throw new Error(`Revert did not match in ${target.file}: ${op.to.slice(0, 80)}`);
		}
		next = next.split(op.to).join(op.from);
	}
	if (next === previous) {
		return { file, previous, rel: target.file, skipped: true };
	}
	fs.writeFileSync(file, next, "utf8");
	return { file, previous, rel: target.file };
}

export function restoreMemory(files: SnapFile[]): void {
	for (const item of [...files].reverse()) {
		fs.writeFileSync(item.file, item.previous, "utf8");
	}
}

type Manifest = {
	files: { original: string; rel: string }[];
};

export function writeSnapshot(snapshotDir: string, files: SnapFile[]): void {
	fs.mkdirSync(snapshotDir, { recursive: true });
	const manifest: Manifest = { files: [] };
	for (const item of files) {
		const dest = path.join(snapshotDir, "files", item.rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, item.previous, "utf8");
		manifest.files.push({ original: item.file, rel: item.rel });
	}
	fs.writeFileSync(path.join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function restoreSnapshot(snapshotDir: string, onlyRels?: Iterable<string>): string[] {
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
		fs.copyFileSync(snap, item.original);
		restored.push(item.original);
	}
	return restored;
}
