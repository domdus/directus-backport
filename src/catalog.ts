import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Advisory, Catalog, PatchTarget, PortInfo } from "./types.js";
import { versionSatisfies, isNewerOrEqual } from "./semver-range.js";
import { resolveCatalogDir } from "./catalog-source.js";

type RawPort = {
	status: PortInfo["status"];
	risk: PortInfo["risk"];
	notes?: string;
	source_commit?: string;
	targets?: RawTarget[];
};

type RawTarget = {
	file: string;
	before_sha256: string;
	after_sha256?: string;
	diff?: string;
	diff_file?: string;
	replace?: { from: string; to: string }[];
	pin?: string;
};

type RawAdvisory = {
	id: string;
	title: string;
	severity: Advisory["severity"];
	advisory: string;
	affects: string;
	upstream_patched: string;
	port: RawPort;
};

type RawCatalog = {
	catalog_version: number;
	updated?: string;
	notes?: string;
	advisories: RawAdvisory[];
};

function mapTargets(list: RawTarget[] | undefined, patchDir: string): PatchTarget[] {
	const targets: PatchTarget[] = [];
	for (const t of list ?? []) {
		let diff = t.diff;
		if (!diff && t.diff_file) {
			const file = path.join(patchDir, t.diff_file);
			diff = fs.readFileSync(file, "utf8");
		}
		targets.push({
			file: t.file,
			beforeSha256: t.before_sha256,
			afterSha256: t.after_sha256,
			diff,
			replace: t.replace,
			pin: t.pin,
		});
	}
	return targets;
}

function withPin(targets: PatchTarget[], pin: string): PatchTarget[] {
	return targets.map((target) => ({ ...target, pin: target.pin || pin }));
}

function loadTargets(raw: RawPort, patchDir: string): PatchTarget[] {
	const targets = withPin(mapTargets(raw.targets, patchDir), "11.17.4");
	const overlays: [string, string][] = [
		["targets.yml", "11.17.4"],
		["10.13.4.yml", "10.13.4"],
		["9.26.0.yml", "9.26.0"],
	];
	for (const [name, pin] of overlays) {
		const overlay = path.join(patchDir, name);
		if (!fs.existsSync(overlay)) continue;
		const extra = parseYaml(fs.readFileSync(overlay, "utf8")) as RawTarget[] | { targets: RawTarget[] };
		const list = Array.isArray(extra) ? extra : extra.targets ?? [];
		targets.push(...withPin(mapTargets(list, patchDir), pin));
	}
	return targets;
}

function toAdvisory(raw: RawAdvisory, catalogRoot: string): Advisory {
	const patchDir = path.join(catalogRoot, "patches", raw.id);
	return {
		id: raw.id,
		title: raw.title,
		severity: raw.severity,
		advisory: raw.advisory,
		affects: raw.affects,
		upstreamPatched: raw.upstream_patched,
		port: {
			status: raw.port.status,
			risk: raw.port.risk,
			notes: raw.port.notes,
			sourceCommit: raw.port.source_commit,
			targets: fs.existsSync(patchDir) ? loadTargets(raw.port, patchDir) : withPin((raw.port.targets ?? []).map((t) => ({
				file: t.file,
				beforeSha256: t.before_sha256,
				afterSha256: t.after_sha256,
				diff: t.diff,
				replace: t.replace,
				pin: t.pin,
			})), "11.17.4"),
		},
	};
}

export function loadCatalog(catalogRoot?: string): Catalog {
	const root = catalogRoot || resolveCatalogDir();
	const file = path.join(root, "advisories.yml");
	if (!fs.existsSync(file)) {
		throw new Error(`Catalog not found: ${file}`);
	}
	const raw = parseYaml(fs.readFileSync(file, "utf8")) as RawCatalog;
	return {
		catalogVersion: raw.catalog_version,
		updated: raw.updated,
		notes: raw.notes,
		source: file,
		advisories: (raw.advisories ?? []).map((item) => toAdvisory(item, root)),
	};
}

export function targetsForVersion(advisory: Advisory, version: string): PatchTarget[] {
	return advisory.port.targets.filter((target) => (target.pin || "11.17.4") === version);
}

export function isStillVulnerable(advisory: Advisory, version: string): boolean {
	return versionSatisfies(version, advisory.affects);
}

export function isFixedOnThisVersion(advisory: Advisory, version: string): boolean {
	return advisory.port.status === "already-fixed" && isNewerOrEqual(version, advisory.upstreamPatched);
}

export function advisoryApplies(advisory: Advisory, version: string): boolean {
	return isStillVulnerable(advisory, version) || isFixedOnThisVersion(advisory, version);
}

export function hasApplyablePatch(advisory: Advisory, version?: string): boolean {
	const targets = version ? targetsForVersion(advisory, version) : advisory.port.targets;
	if (targets.length === 0) return false;
	if (advisory.port.status !== "experimental" && advisory.port.status !== "stable") return false;
	if (version) return isStillVulnerable(advisory, version);
	return true;
}

export function partitionAdvisories(catalog: Catalog, version: string) {
	const alreadyFixed = catalog.advisories.filter((a) => isFixedOnThisVersion(a, version));
	const open = catalog.advisories.filter((a) => isStillVulnerable(a, version));
	const applicable = catalog.advisories.filter((a) => advisoryApplies(a, version));
	const ready = open.filter((a) => targetsForVersion(a, version).length > 0);
	const waiting = open.filter((a) => targetsForVersion(a, version).length === 0);
	return { applicable, alreadyFixed, open, ready, waiting };
}
