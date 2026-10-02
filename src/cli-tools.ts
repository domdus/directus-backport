import fs from "node:fs";
import path from "node:path";
import type { DirectusInstall } from "./types.js";
import { dataDir, findPackageRoot } from "./paths.js";
import { desiredPath } from "./desired.js";
import { loadState } from "./state.js";

export type CliToolsOptions = {
	/** Catalog dir (bundled catalog/ or catalog-remote/). */
	catalogRoot?: string;
	/** Extension / CLI package root that should contain dist/cli.mjs. */
	packageRoot?: string;
};

function resolvePackageRoot(opts?: string | CliToolsOptions): string {
	if (typeof opts === "string") {
		return path.dirname(path.resolve(opts));
	}
	if (opts?.packageRoot) return path.resolve(opts.packageRoot);
	if (opts?.catalogRoot) return path.dirname(path.resolve(opts.catalogRoot));
	return findPackageRoot();
}

/** Extension build output: dist/cli.mjs. */
export function bundledCliPath(opts?: string | CliToolsOptions): string {
	return path.join(resolvePackageRoot(opts), "dist", "cli.mjs");
}

export function emergencyRollbackPath(opts?: string | CliToolsOptions): string {
	return path.join(resolvePackageRoot(opts), "dist", "rollback.mjs");
}

export function rollbackCommands(opts?: string | CliToolsOptions) {
	const cli = bundledCliPath(opts);
	return {
		cli: `node ${cli} rollback`,
		docker: `docker compose run --no-deps --entrypoint node directus ${cli} rollback`,
	};
}

export function cliStatus(install: DirectusInstall, opts?: string | CliToolsOptions) {
	const normalized: CliToolsOptions =
		typeof opts === "string" ? { catalogRoot: opts } : opts ?? {};
	const packageRoot = resolvePackageRoot(normalized);
	const catalogRoot = normalized.catalogRoot;
	const bundledPath = bundledCliPath(normalized);
	const emergencyRollback = emergencyRollbackPath(normalized);
	const desiredFile = loadState(install.nodeModules).desiredFile || desiredPath(catalogRoot);
	const snapshots = dataDir(install.nodeModules);
	const commands = rollbackCommands(normalized);
	return {
		bundled: fs.existsSync(bundledPath),
		bundledPath,
		packageRoot,
		emergencyRollback,
		rollbackCli: commands.cli,
		rollbackDocker: commands.docker,
		desiredFile,
		dataDir: snapshots,
		workingFilesPresent: fs.existsSync(desiredFile) || fs.existsSync(snapshots),
	};
}

export function purgeWorkingFiles(install: DirectusInstall, opts?: string | CliToolsOptions) {
	const normalized: CliToolsOptions =
		typeof opts === "string" ? { catalogRoot: opts } : opts ?? {};
	const desiredFile =
		loadState(install.nodeModules).desiredFile || desiredPath(normalized.catalogRoot);
	const snapshots = dataDir(install.nodeModules);
	const removed: string[] = [];
	for (const file of [desiredFile, snapshots]) {
		if (!fs.existsSync(file)) continue;
		fs.rmSync(file, { recursive: true, force: true });
		removed.push(file);
	}
	return { removed };
}
