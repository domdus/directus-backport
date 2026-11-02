import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMPORT_TIMEOUT_MS = 90_000;

// Ends the child explicitly: Directus modules keep handles open once imported.
const LOADER = `
for (const url of JSON.parse(process.env.DIRECTUS_BACKPORT_PREFLIGHT)) await import(url);
process.exit(0);
`;

function failure(err: unknown): string {
	const { stderr, message } = err as { stderr?: string; message?: string };
	const detail = String(stderr || message || err).trim();
	return detail.split("\n").slice(0, 6).join("\n");
}

/**
 * Load patched modules in a child process before the real one restarts. A module
 * that cannot load would crash Directus before any extension runs, so this is the
 * only point where that failure can still be caught from inside Directus.
 */
export async function preflightFiles(root: string, files: string[]): Promise<void> {
	for (const file of files) {
		try {
			await run(process.execPath, ["--check", file], { timeout: 30_000 });
		} catch (err) {
			throw new Error(`Patched file does not parse: ${file}\n${failure(err)}`);
		}
	}
	try {
		await run(process.execPath, ["--input-type=module", "--eval", LOADER], {
			cwd: root,
			timeout: IMPORT_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: {
				...process.env,
				DIRECTUS_BACKPORT_PREFLIGHT: JSON.stringify(files.map((file) => pathToFileURL(file).href)),
			},
		});
	} catch (err) {
		throw new Error(`Patched modules did not load:\n${failure(err)}`);
	}
}
