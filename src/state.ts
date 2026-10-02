import path from "node:path";
import type { StateFile } from "./types.js";
import { dataDir, readJson, writeJson } from "./paths.js";

export function stateFile(nodeModules: string): string {
	return path.join(dataDir(nodeModules), "state.json");
}

export function loadState(nodeModules: string): StateFile {
	return readJson<StateFile>(stateFile(nodeModules), { applied: [] });
}

export function saveState(nodeModules: string, state: StateFile): void {
	writeJson(stateFile(nodeModules), state);
}

export function latestSnapshot(nodeModules: string): string | null {
	const state = loadState(nodeModules);
	return state.last?.snapshot ?? state.applied.at(-1)?.snapshot ?? null;
}
