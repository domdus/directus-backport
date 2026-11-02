/**
 * Run every overlay against the Directus packages it is pinned to, straight from npm.
 * Patched modules are parsed, never executed. Exits non-zero on any problem.
 *
 *   npm run verify:catalog
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, partitionAdvisories, targetsForVersion } from "../src/catalog.js";
import { detectInstall } from "../src/detect.js";
import { applyPatches, rollbackAdvisory, rollbackAll, statusReport } from "../src/engine.js";
import { sha256 } from "../src/patch.js";
import { verifyCatalogDir } from "../src/trust.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogDir = path.join(repo, "catalog");
const PINS = ["11.17.4", "10.13.4", "9.26.0"];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-verify-"));
process.env.DIRECTUS_BACKPORT_DESIRED = path.join(work, "desired.json");
const problems: string[] = [];
const report = (pin: string, message: string) => problems.push(`${pin}: ${message}`);

function npm(...args: string[]): string {
	return execFileSync("npm", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function fetchPin(pin: string): string {
	const root = path.join(work, pin);
	const nodeModules = path.join(root, "node_modules");
	const api = path.join(nodeModules, "@directus", "api");
	fs.mkdirSync(api, { recursive: true });
	fs.mkdirSync(path.join(nodeModules, "directus"), { recursive: true });
	fs.writeFileSync(path.join(nodeModules, "directus", "package.json"), JSON.stringify({ name: "directus", version: pin }));
	const version = JSON.parse(npm("view", `directus@${pin}`, "dependencies", "--json"))["@directus/api"];
	const tarball = path.join(work, npm("pack", `@directus/api@${version}`, "--silent").split("\n").at(-1)!);
	execFileSync("tar", ["-xzf", tarball, "-C", api, "--strip-components=1"]);
	return root;
}

try {
	verifyCatalogDir(catalogDir);
} catch (err) {
	problems.push(`signature: ${err instanceof Error ? err.message : err}`);
}

const catalog = loadCatalog(catalogDir);
for (const pin of PINS) {
	const root = fetchPin(pin);
	const nodeModules = path.join(root, "node_modules");
	const install = detectInstall(root);
	const ready = partitionAdvisories(catalog, pin).ready;
	const ids = ready.map((advisory) => advisory.id);
	const pristine = new Map<string, Buffer>();
	const at = (rel: string) => path.join(nodeModules, rel);

	for (const advisory of ready) {
		for (const target of targetsForVersion(advisory, pin)) {
			if (!fs.existsSync(at(target.file))) {
				report(pin, `${advisory.id} targets a missing file ${target.file}`);
				continue;
			}
			if (!pristine.has(target.file)) pristine.set(target.file, fs.readFileSync(at(target.file)));
			const source = pristine.get(target.file)!;
			if (sha256(source) !== target.beforeSha256) report(pin, `${advisory.id} before_sha256 is wrong for ${target.file}`);
			if (!target.afterSha256) report(pin, `${advisory.id} has no after_sha256 for ${target.file}`);
			let next = source.toString("utf8");
			for (const op of target.replace ?? []) {
				const hits = next.split(op.from).length - 1;
				if (hits !== 1) report(pin, `${advisory.id} search text matches ${hits} times in ${target.file}`);
				next = next.split(op.from).join(op.to);
			}
			if (target.afterSha256 && sha256(next) !== target.afterSha256) {
				report(pin, `${advisory.id} after_sha256 is wrong for ${target.file}`);
			}
		}
	}

	const reset = () => {
		for (const [rel, bytes] of pristine) fs.writeFileSync(at(rel), bytes);
		fs.rmSync(path.join(root, ".directus-backport"), { recursive: true, force: true });
		fs.rmSync(process.env.DIRECTUS_BACKPORT_DESIRED!, { force: true });
	};
	const dirty = () => [...pristine].filter(([rel, bytes]) => !fs.readFileSync(at(rel)).equals(bytes)).map(([rel]) => rel);
	const snapshotBytes = () => new Map([...pristine.keys()].map((rel) => [rel, fs.readFileSync(at(rel))]));
	const parse = (label: string) => {
		for (const rel of pristine.keys()) {
			const check = spawnSync(process.execPath, ["--check", at(rel)], { encoding: "utf8" });
			if (check.status !== 0) report(pin, `${label}: ${rel} does not parse: ${check.stderr.match(/SyntaxError.*/)?.[0]}`);
		}
	};
	const apply = async (list: string[], label: string) => {
		const result = await applyPatches(install, { ids: list }, catalogDir);
		if (!result.ok) report(pin, `${label}: ${String(result.error).split("\n")[0]}`);
		return result.ok;
	};

	for (const id of ids) {
		reset();
		if (!(await apply([id], `apply ${id}`))) continue;
		rollbackAdvisory(install, id, catalogDir);
		if (dirty().length) report(pin, `rollback of ${id} left ${dirty().join(", ")} patched`);
		await apply([id], `re-apply ${id}`);
		parse(`re-apply ${id}`);
	}

	reset();
	if (await apply(ids, "apply all")) {
		parse("apply all");
		for (const id of ids) {
			const others = ids.filter((item) => item !== id);
			reset();
			if (others.length) await apply(others, `apply all but ${id}`);
			const expected = snapshotBytes();
			reset();
			await apply(ids, "apply all");
			rollbackAdvisory(install, id, catalogDir);
			const wrong = [...expected].filter(([rel, bytes]) => !fs.readFileSync(at(rel)).equals(bytes)).map(([rel]) => rel);
			if (wrong.length) report(pin, `rollback of ${id} changed its neighbours in ${wrong.join(", ")}`);
		}

		reset();
		await apply(ids, "apply all");
		rollbackAll(install, catalogDir);
		if (dirty().length) report(pin, `rollback --all left ${dirty().join(", ")}`);

		reset();
		await apply(ids, "apply all");
		const emergency = spawnSync(process.execPath, [path.join(repo, "scripts", "rollback.mjs"), root, "all"], { encoding: "utf8" });
		if (emergency.status !== 0) report(pin, `rollback.mjs failed: ${emergency.stderr}`);
		if (dirty().length) report(pin, `rollback.mjs left ${dirty().join(", ")}`);

		reset();
		await apply(ids, "apply all");
		const patched = snapshotBytes();
		fs.rmSync(path.join(root, ".directus-backport"), { recursive: true, force: true });
		const seen = statusReport(install, catalogDir);
		if (seen.counts.applied !== ids.length) report(pin, `lost state: found ${seen.counts.applied} of ${ids.length} in the files`);
		for (const [rel, bytes] of patched) {
			if (!fs.readFileSync(at(rel)).equals(bytes)) report(pin, `lost state: ${rel} changed`);
		}
		rollbackAll(install, catalogDir);
		if (dirty().length) report(pin, `lost state: rollback left ${dirty().join(", ")}`);
	}
	reset();
	console.log(`${pin}: ${ids.length} advisories, ${pristine.size} files checked`);
}

fs.rmSync(work, { recursive: true, force: true });
if (problems.length) {
	console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log("Catalog verified.");
