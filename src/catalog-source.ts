import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { findPackageRoot } from "./paths.js";

export type CatalogSource = {
	github: string | null;
	ref: string;
	tarballUrl: string | null;
};

const DEFAULT_GITHUB = "domdus/directus-backport";
const DEFAULT_REF = "main";

function parseGithub(value: string): string | null {
	const trimmed = value.trim().replace(/\.git$/, "");
	if (!trimmed) return null;
	const url = trimmed.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
	if (url) return `${url[1]}/${url[2]}`;
	if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed;
	return null;
}

function readSourceFile(): { github?: string; ref?: string } {
	try {
		const file = path.join(findPackageRoot(), "catalog", "source.yml");
		if (!fs.existsSync(file)) return {};
		return (parseYaml(fs.readFileSync(file, "utf8")) as { github?: string; ref?: string }) ?? {};
	} catch {
		return {};
	}
}

/**
 * Built-in marketplace: github.com/domdus/directus-backport @ main.
 * Env is only an override (forks / a private mirror).
 */
export function loadCatalogSource(): CatalogSource {
	const fromFile = readSourceFile();
	const github = parseGithub(
		process.env.DIRECTUS_BACKPORT_CATALOG || fromFile.github || DEFAULT_GITHUB,
	);
	const ref =
		(process.env.DIRECTUS_BACKPORT_CATALOG_REF || fromFile.ref || DEFAULT_REF).trim() || DEFAULT_REF;
	const tarballUrl = github
		? `https://codeload.github.com/${github}/tar.gz/${encodeURIComponent(ref)}`
		: null;
	return { github, ref, tarballUrl };
}

export function bundledCatalogDir(): string {
	return path.join(findPackageRoot(), "catalog");
}

export function remoteCatalogDir(): string {
	return path.join(findPackageRoot(), "catalog-remote");
}

export function remoteMetaPath(): string {
	return path.join(remoteCatalogDir(), ".fetched.json");
}

export function resolveCatalogDir(): string {
	const remote = path.join(remoteCatalogDir(), "advisories.yml");
	if (fs.existsSync(remote)) return remoteCatalogDir();
	return bundledCatalogDir();
}
