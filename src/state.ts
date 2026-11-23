import path from "node:path";
import type { StateFile } from "./types.js";
import { dataDir, readJson, writeJson } from "./paths.js";

export function stateFile(nodeModules: string): string {
	return path.join(dataDir(nodeModules), "state.json");
}

const warnedForeign = new Set<string>();

/**
 * True when state.json was written for another install: the whole Directus folder was copied
 * (e.g. a second instance cloned from the first), state.json came along, and its desiredFile
 * still points into the other install. Using it would make both installs share one desired.json,
 * so the boot re-apply of one would follow applies and rollbacks of the other.
 */
export function stateFromOtherInstall(nodeModules: string, state: StateFile): boolean {
	const here = path.resolve(nodeModules);
	if (state.installRoot) return path.resolve(state.installRoot) !== here;
	if (!state.desiredFile) return false;
	// Older state files have no installRoot: a desired.json inside some install's extensions
	// folder belongs to that install. Elsewhere (next to a CLI catalog, DIRECTUS_BACKPORT_DESIRED)
	// it is shared on purpose.
	const marker = `${path.sep}extensions${path.sep}`;
	const file = path.resolve(state.desiredFile);
	const at = file.indexOf(marker);
	if (at < 0) return false;
	return file.slice(0, at) !== path.dirname(here);
}

export function loadState(nodeModules: string): StateFile {
	const state = readJson<StateFile>(stateFile(nodeModules), { applied: [] });
	if (stateFromOtherInstall(nodeModules, state)) {
		const key = path.resolve(nodeModules);
		if (!warnedForeign.has(key)) {
			warnedForeign.add(key);
			process.stderr.write(
				`directus-backport: state.json in ${dataDir(nodeModules)} was written for another install ` +
					`(desired.json ${state.desiredFile ?? "?"}); using this install's own desired.json.\n`,
			);
		}
		delete state.desiredFile;
	}
	return state;
}

export function saveState(nodeModules: string, state: StateFile): void {
	writeJson(stateFile(nodeModules), { ...state, installRoot: path.resolve(nodeModules) });
}

export function latestSnapshot(nodeModules: string): string | null {
	const state = loadState(nodeModules);
	return state.last?.snapshot ?? state.applied.at(-1)?.snapshot ?? null;
}
