import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Advisory, Catalog, PatchTarget, PortInfo, PortStatus } from "./types.js";
import { versionSatisfies, isNewerOrEqual } from "./semver-range.js";
import { resolveCatalogDir } from "./catalog-source.js";

export const SUPPORTED_CATALOG_VERSION = 1;

const STATUSES: PortStatus[] = ["already-fixed", "needs-port", "experimental", "stable", "wont-port"];
const RISKS: PortInfo["risk"][] = ["none", "low", "medium", "high"];
const SEVERITIES: Advisory["severity"][] = ["critical", "high", "medium", "low"];
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A patch is code that runs inside Directus. Keep it to compiled Directus packages.
const TARGET_FILE = /^@directus\/[a-z0-9-]+\/dist\/[A-Za-z0-9_./-]+\.(js|cjs|mjs)$/;
const DIFF_FILE = /^[A-Za-z0-9_.-]+\.patch$/;

function invalid(where: string, why: string): Error {
	return new Error(`Invalid catalog entry ${where}: ${why}`);
}

function validateTarget(id: string, target: RawTarget): void {
	const where = `${id} ${target?.file ?? "(no file)"}`;
	if (typeof target?.file !== "string" || !TARGET_FILE.test(target.file) || target.file.split("/").includes("..")) {
		throw invalid(where, "file must be a dist file of an @directus package");
	}
	if (typeof target.before_sha256 !== "string" || !SHA256.test(target.before_sha256)) {
		throw invalid(where, "before_sha256 must be a sha256 hex digest");
	}
	if (target.after_sha256 !== undefined && !SHA256.test(String(target.after_sha256))) {
		throw invalid(where, "after_sha256 must be a sha256 hex digest");
	}
	if (target.diff_file !== undefined && !DIFF_FILE.test(String(target.diff_file))) {
		throw invalid(where, "diff_file must be a .patch file next to the overlay");
	}
	for (const op of target.replace ?? []) {
		if (typeof op?.from !== "string" || !op.from || typeof op?.to !== "string") {
			throw invalid(where, "replace entries need a non-empty from and a to");
		}
	}
	if (!target.replace?.length && !target.diff && !target.diff_file) {
		throw invalid(where, "a target needs replace, diff, or diff_file");
	}
}

function validateAdvisory(raw: RawAdvisory): void {
	if (typeof raw?.id !== "string" || !GHSA.test(raw.id)) {
		throw invalid(String(raw?.id), "id must be a GHSA id");
	}
	if (!SEVERITIES.includes(raw.severity)) throw invalid(raw.id, `unknown severity ${raw.severity}`);
	if (!STATUSES.includes(raw.port?.status)) throw invalid(raw.id, `unknown status ${raw.port?.status}`);
	if (!RISKS.includes(raw.port.risk)) throw invalid(raw.id, `unknown risk ${raw.port.risk}`);
	for (const [pin, status] of Object.entries(raw.port.pins ?? {})) {
		if (!STATUSES.includes(status)) throw invalid(raw.id, `unknown status ${status} for ${pin}`);
	}
	for (const target of raw.port.targets ?? []) validateTarget(raw.id, target);
}

type RawPort = {
	status: PortInfo["status"];
	risk: PortInfo["risk"];
	notes?: string;
	source_commit?: string;
	pins?: Record<string, PortStatus>;
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

function mapTargets(list: RawTarget[] | undefined, patchDir: string, id: string): PatchTarget[] {
	const targets: PatchTarget[] = [];
	for (const t of list ?? []) {
		validateTarget(id, t);
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

function loadTargets(raw: RawPort, patchDir: string, id: string): PatchTarget[] {
	const targets = withPin(mapTargets(raw.targets, patchDir, id), "11.17.4");
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
		targets.push(...withPin(mapTargets(list, patchDir, id), pin));
	}
	return targets;
}

function toAdvisory(raw: RawAdvisory, catalogRoot: string): Advisory {
	validateAdvisory(raw);
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
			pins: raw.port.pins,
			targets: fs.existsSync(patchDir) ? loadTargets(raw.port, patchDir, raw.id) : withPin((raw.port.targets ?? []).map((t) => ({
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
	if (raw.catalog_version !== SUPPORTED_CATALOG_VERSION) {
		throw new Error(
			`Catalog version ${raw.catalog_version} is not supported (this build reads ${SUPPORTED_CATALOG_VERSION}). Update directus-backport.`,
		);
	}
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

/** Maturity of the port for one Directus version; each pin is promoted on its own. */
export function statusForVersion(advisory: Advisory, version: string): PortStatus {
	const pinned = advisory.port.pins?.[version];
	if (pinned) return pinned;
	// `already-fixed` describes the newest line. An overlay here means an older pin still needs it.
	if (advisory.port.status === "already-fixed" && targetsForVersion(advisory, version).length > 0) {
		return "experimental";
	}
	return advisory.port.status;
}

/** Every target of this version touching `file`, across all advisories. */
export function targetsForFile(catalog: Catalog, version: string, file: string): PatchTarget[] {
	return catalog.advisories.flatMap((advisory) =>
		targetsForVersion(advisory, version).filter((target) => target.file === file),
	);
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
	if (version) {
		const status = statusForVersion(advisory, version);
		if (status === "needs-port" || status === "wont-port") return false;
		return isStillVulnerable(advisory, version);
	}
	if (advisory.port.status === "needs-port" || advisory.port.status === "wont-port") return false;
	return advisory.port.status === "experimental" || advisory.port.status === "stable" || advisory.port.status === "already-fixed";
}

export function partitionAdvisories(catalog: Catalog, version: string) {
	const alreadyFixed = catalog.advisories.filter((a) => isFixedOnThisVersion(a, version));
	const open = catalog.advisories.filter((a) => isStillVulnerable(a, version));
	const applicable = catalog.advisories.filter((a) => advisoryApplies(a, version));
	const ready = open.filter((a) => targetsForVersion(a, version).length > 0);
	const waiting = open.filter((a) => targetsForVersion(a, version).length === 0);
	return { applicable, alreadyFixed, open, ready, waiting };
}
