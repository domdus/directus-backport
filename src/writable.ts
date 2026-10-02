import fs from "node:fs";
import path from "node:path";
import { resolveNodeFile } from "./detect.js";
import { dataDir } from "./paths.js";
import type { DirectusInstall, WriteAccess } from "./types.js";

export type { WriteAccess };

function tryOpenForWrite(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r+");
		fs.closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function tryWriteDir(dir: string): { ok: boolean; error?: string } {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const probe = path.join(dir, ".write-probe");
		fs.writeFileSync(probe, "ok");
		fs.unlinkSync(probe);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function sampleNodeFiles(nodeModules: string): string[] {
	const files = [path.join(nodeModules, "directus", "package.json")];
	for (const rel of ["@directus/api/package.json", "@directus/api/dist/index.js"]) {
		try {
			files.push(resolveNodeFile(nodeModules, rel));
		} catch {
			/* package layout differs by major */
		}
	}
	return files.filter((file) => fs.existsSync(file));
}

/**
 * Probe whether this process can snapshot and rewrite Directus node_modules.
 * `fs.access(W_OK)` is not enough on overlay/read-only images — we open for write.
 */
export function probeWriteAccess(install: DirectusInstall): WriteAccess {
	const snapshot = tryWriteDir(dataDir(install.nodeModules));
	let nodeModulesWritable = true;
	let nodeReason: string | undefined;

	for (const file of sampleNodeFiles(install.nodeModules)) {
		if (tryOpenForWrite(file)) continue;
		nodeModulesWritable = false;
		nodeReason = `Cannot write ${file}`;
		break;
	}

	if (!fs.existsSync(install.nodeModules)) {
		nodeModulesWritable = false;
		nodeReason = `node_modules does not exist: ${install.nodeModules}`;
	}

	const writable = snapshot.ok && nodeModulesWritable;
	let reason: string | undefined;
	if (!writable) {
		if (!snapshot.ok) {
			reason = `Cannot write snapshot directory ${dataDir(install.nodeModules)}${snapshot.error ? `: ${snapshot.error}` : ""}`;
		} else {
			reason =
				nodeReason ||
				`This process cannot write files under ${install.nodeModules}. Run the CLI as a user that owns the install, or apply from a writable bind-mount.`;
		}
	}

	return {
		writable,
		snapshotWritable: snapshot.ok,
		nodeModulesWritable,
		reason,
	};
}
