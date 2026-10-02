import fs from "node:fs";
import path from "node:path";
import type { DirectusInstall } from "./types.js";
import { dataDir, findPackageRoot, readJson, writeJson } from "./paths.js";
import { desiredPath } from "./desired.js";
import { loadState } from "./state.js";

const INSTALL_FILE = "cli-install.json";

type CliInstallRecord = {
	path: string;
	updated: string;
};

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

function installRecordPath(catalogRoot?: string): string {
	return path.join(extensionRoot(catalogRoot), INSTALL_FILE);
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
	const record = readJson<CliInstallRecord | null>(installRecordPath(catalogRoot), null);
	const hostCommand = record?.path || path.join(install.root, "directus-backport");
	const desiredFile = loadState(install.nodeModules).desiredFile || desiredPath(catalogRoot);
	const snapshots = dataDir(install.nodeModules);
	const commands = rollbackCommands(catalogRoot);
	return {
		bundled: fs.existsSync(bundledPath),
		bundledPath,
		emergencyRollback: emergencyRollbackPath(catalogRoot),
		hostCommand,
		hostCommandInstalled: Boolean(record?.path && fs.existsSync(record.path)),
		rollbackCli: commands.cli,
		rollbackDocker: commands.docker,
		desiredFile,
		dataDir: snapshots,
		workingFilesPresent: fs.existsSync(desiredFile) || fs.existsSync(snapshots),
	};
}

export function installHostCli(install: DirectusInstall, catalogRoot?: string) {
	const bundled = bundledCliPath(catalogRoot);
	if (!fs.existsSync(bundled)) {
		throw new Error(`Bundled CLI is missing at ${bundled}. Rebuild the extension.`);
	}
	const target = path.join(install.root, "directus-backport");
	const script = `#!/usr/bin/env node
const { spawn } = require("child_process");
const child = spawn(process.execPath, ${JSON.stringify([bundled])}.concat(process.argv.slice(2)), { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
	console.error(err);
	process.exit(1);
});
`;
	fs.writeFileSync(target, script, { mode: 0o755 });
	writeJson(installRecordPath(catalogRoot), { path: target, updated: new Date().toISOString() });
	return { path: target };
}

export function uninstallHostCli(catalogRoot?: string) {
	const record = readJson<CliInstallRecord | null>(installRecordPath(catalogRoot), null);
	const removed: string[] = [];
	if (record?.path && fs.existsSync(record.path)) {
		fs.rmSync(record.path);
		removed.push(record.path);
	}
	const marker = installRecordPath(catalogRoot);
	if (fs.existsSync(marker)) {
		fs.rmSync(marker);
		removed.push(marker);
	}
	return { removed };
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
