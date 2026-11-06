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

const UNWRITABLE = new Set(["EROFS", "EACCES", "EPERM"]);

/**
 * desired.json only feeds the Studio boot re-apply. When the CLI lives somewhere read-only
 * (a mounted checkout, an image layer), the patch itself already succeeded and state.json
 * records it, so a failed write is a warning, not a failed apply or rollback.
 */
export function saveDesired(desired: DesiredFile, catalogRoot?: string, file?: string): void {
	const target = file || desiredPath(catalogRoot);
	try {
		writeJson(target, {
			version: desired.version,
			ids: [...new Set(desired.ids)].sort(),
			updated: new Date().toISOString(),
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (!code || !UNWRITABLE.has(code)) throw err;
		process.stderr.write(
			`warning: could not write ${target} (${code}); the Studio boot hook will not re-apply this change. ` +
				`Set DIRECTUS_BACKPORT_DESIRED to a writable path if you use it.\n`,
		);
	}
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
