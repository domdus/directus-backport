import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState, saveState, stateFromOtherInstall } from "../src/state.js";

function install(base: string, name: string): string {
	const nodeModules = path.join(base, name, "node_modules");
	fs.mkdirSync(nodeModules, { recursive: true });
	return nodeModules;
}

function writeRaw(nodeModules: string, state: object): void {
	const dir = path.join(nodeModules, "..", ".directus-backport");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
}

test("a state.json copied from another install does not keep its desired.json", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "bp-state-"));
	const cms = install(base, "directus");
	const copy = install(base, "directus-fangigs");
	const cmsDesired = path.join(base, "directus", "extensions", "directus-extension-backport", "desired.json");
	// Old state without installRoot, copied along with the folder.
	writeRaw(copy, { applied: [], desiredFile: cmsDesired });
	assert.equal(stateFromOtherInstall(copy, { applied: [], desiredFile: cmsDesired }), true);
	assert.equal(loadState(copy).desiredFile, undefined);
	// The original install keeps it.
	writeRaw(cms, { applied: [], desiredFile: cmsDesired });
	assert.equal(loadState(cms).desiredFile, cmsDesired);
});

test("installRoot written by saveState detects a copy even with a shared desired.json path", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "bp-state-"));
	const cms = install(base, "directus");
	const copy = install(base, "directus-fangigs");
	const shared = path.join(base, "cli", "desired.json");
	saveState(cms, { applied: [], desiredFile: shared });
	assert.equal(loadState(cms).desiredFile, shared);
	fs.cpSync(path.join(base, "directus", ".directus-backport"), path.join(base, "directus-fangigs", ".directus-backport"), { recursive: true });
	assert.equal(loadState(copy).desiredFile, undefined);
});

test("a desired.json outside any extensions folder stays shared on purpose (old state)", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "bp-state-"));
	const nm = install(base, "directus");
	const shared = path.join(base, "cli", "desired.json");
	writeRaw(nm, { applied: [], desiredFile: shared });
	assert.equal(loadState(nm).desiredFile, shared);
});
