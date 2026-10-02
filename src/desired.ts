import path from "node:path";
import { findPackageRoot, readJson, writeJson } from "./paths.js";

export type DesiredFile = {
	version: string;
	ids: string[];
	updated: string;
};

export function desiredPath(catalogRoot?: string): string {
	if (process.env.DIRECTUS_BACKPORT_DESIRED) {
		return path.resolve(process.env.DIRECTUS_BACKPORT_DESIRED);
	}
	const catalog = catalogRoot || path.join(findPackageRoot(), "catalog");
	return path.join(path.dirname(path.resolve(catalog)), "desired.json");
}

export function loadDesired(catalogRoot?: string, file?: string): DesiredFile {
	return readJson<DesiredFile>(file || desiredPath(catalogRoot), {
		version: "",
		ids: [],
		updated: "",
	});
}

export function saveDesired(desired: DesiredFile, catalogRoot?: string, file?: string): void {
	writeJson(file || desiredPath(catalogRoot), {
		version: desired.version,
		ids: [...new Set(desired.ids)].sort(),
		updated: new Date().toISOString(),
	});
}

export function addDesiredIds(ids: string[], version: string, catalogRoot?: string, file?: string): void {
	if (ids.length === 0) return;
	const current = loadDesired(catalogRoot, file);
	saveDesired(
		{
			version: version || current.version,
			ids: [...current.ids, ...ids],
			updated: "",
		},
		catalogRoot,
		file,
	);
}

export function removeDesiredIds(ids: string[], catalogRoot?: string, file?: string): void {
	if (ids.length === 0) return;
	const drop = new Set(ids);
	const current = loadDesired(catalogRoot, file);
	saveDesired(
		{
			version: current.version,
			ids: current.ids.filter((id) => !drop.has(id)),
			updated: "",
		},
		catalogRoot,
		file,
	);
}
