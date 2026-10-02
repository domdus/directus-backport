import { detectInstall } from "../../../src/detect.js";
import { resolveCatalogDir } from "../../../src/catalog-source.js";

export function installFromEnv() {
	return detectInstall(process.env.DIRECTUS_BACKPORT_ROOT || undefined);
}

export function catalogRoot(): string | undefined {
	try {
		return resolveCatalogDir();
	} catch {
		return undefined;
	}
}

export function autoReapplyEnabled(): boolean {
	const value = (process.env.DIRECTUS_BACKPORT_AUTO || "1").trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}
