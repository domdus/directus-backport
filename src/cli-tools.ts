import fs from "node:fs";
import path from "node:path";
import type { DirectusInstall } from "./types.js";
import { dataDir, findPackageRoot } from "./paths.js";
import { desiredPath } from "./desired.js";
import { loadState } from "./state.js";

function extensionRoot(catalogRoot?: string): string {
	if (catalogRoot) return path.dirname(path.resolve(catalogRoot));
	return findPackageRoot();
}

export function bundledCliPath(catalogRoot?: string): string {
	return path.join(extensionRoot(catalogRoot), "cli.mjs");
}

export function emergencyRollbackPath(catalogRoot?: string): string {
	return path.join(extensionRoot(catalogRoot), "rollback.mjs");
}

export function rollbackCommands(catalogRoot?: string) {
	const cli = bundledCliPath(catalogRoot);
	return {
		cli: `node ${cli} rollback`,
		docker: `docker compose run --no-deps --entrypoint node directus ${cli} rollback`,
	};
}

export function cliStatus(install: DirectusInstall, catalogRoot?: string) {
	const bundledPath = bundledCliPath(catalogRoot);
	const desiredFile = loadState(install.nodeModules).desiredFile || desiredPath(catalogRoot);
	const snapshots = dataDir(install.nodeModules);
	const commands = rollbackCommands(catalogRoot);
	return {
		bundled: fs.existsSync(bundledPath),
		bundledPath,
		emergencyRollback: emergencyRollbackPath(catalogRoot),
		rollbackCli: commands.cli,
		rollbackDocker: commands.docker,
		desiredFile,
		dataDir: snapshots,
		workingFilesPresent: fs.existsSync(desiredFile) || fs.existsSync(snapshots),
	};
}

export function purgeWorkingFiles(install: DirectusInstall, catalogRoot?: string) {
	const desiredFile = loadState(install.nodeModules).desiredFile || desiredPath(catalogRoot);
	const snapshots = dataDir(install.nodeModules);
	const removed: string[] = [];
	for (const file of [desiredFile, snapshots]) {
		if (!fs.existsSync(file)) continue;
		fs.rmSync(file, { recursive: true, force: true });
		removed.push(file);
	}
	return { removed };
}
