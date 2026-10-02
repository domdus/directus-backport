import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import {
	bundledCatalogDir,
	hasLocalCatalog,
	loadCatalogSource,
	remoteCatalogDir,
	remoteMetaPath,
	resolveCatalogDir,
	type CatalogSource,
} from "./catalog-source.js";
import { writeJson } from "./paths.js";
import { extractCatalogTarGz } from "./tar-catalog.js";

export type CatalogRemoteStatus = {
	configured: boolean;
	github: string | null;
	ref: string;
	tarballUrl: string | null;
	using: "remote" | "bundled" | "none";
	cacheDir: string;
	fetchedAt: string | null;
	advisories: string | null;
};

export type CatalogRefreshResult = {
	ok: true;
	github: string;
	ref: string;
	files: number;
	fetchedAt: string;
	cacheDir: string;
};

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": "directus-backport",
		Accept: "application/vnd.github+json",
	};
	const token = (process.env.DIRECTUS_BACKPORT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function readFetchedAt(): string | null {
	try {
		const meta = JSON.parse(fs.readFileSync(remoteMetaPath(), "utf8")) as { fetchedAt?: string };
		return meta.fetchedAt || null;
	} catch {
		return null;
	}
}

export function catalogRemoteStatus(): CatalogRemoteStatus {
	const source = loadCatalogSource();
	let using: CatalogRemoteStatus["using"] = "none";
	let advisories: string | null = null;
	if (hasLocalCatalog()) {
		const dir = resolveCatalogDir();
		using = dir === remoteCatalogDir() ? "remote" : "bundled";
		advisories = path.join(dir, "advisories.yml");
	}
	return {
		configured: Boolean(source.github),
		github: source.github,
		ref: source.ref,
		tarballUrl: source.tarballUrl,
		using,
		cacheDir: remoteCatalogDir(),
		fetchedAt: readFetchedAt(),
		advisories,
	};
}

async function download(source: CatalogSource): Promise<Buffer> {
	if (!source.tarballUrl || !source.github) {
		throw new Error(
			"No GitHub catalog URL. This build should default to domdus/directus-backport.",
		);
	}
	const res = await fetch(source.tarballUrl, { headers: authHeaders() });
	if (!res.ok) {
		throw new Error(`GitHub catalog fetch failed (${res.status} ${res.statusText}) from ${source.github}@${source.ref}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

/** Opt-in only: Studio “Check for Updates” or `catalog --refresh`. Never called automatically. */
export async function refreshRemoteCatalog(): Promise<CatalogRefreshResult> {
	const source = loadCatalogSource();
	const archive = await download(source);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-catalog-"));
	try {
		const { files } = extractCatalogTarGz(archive, tmp);
		loadCatalog(tmp);
		const dest = remoteCatalogDir();
		fs.rmSync(dest, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(tmp, dest, { recursive: true });
		const fetchedAt = new Date().toISOString();
		writeJson(remoteMetaPath(), {
			github: source.github,
			ref: source.ref,
			fetchedAt,
			files: files.length,
		});
		return {
			ok: true,
			github: source.github as string,
			ref: source.ref,
			files: files.length,
			fetchedAt,
			cacheDir: dest,
		};
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export { bundledCatalogDir, resolveCatalogDir };
