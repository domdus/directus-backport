import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export async function ping(url: string, timeoutMs = 4000): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function runCommand(command: string): Promise<void> {
	await exec(command, { timeout: 120_000 });
}

export async function waitForHealth(url: string, timeoutMs: number, required = 2): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let hits = 0;
	while (Date.now() < deadline) {
		hits = (await ping(url)) ? hits + 1 : 0;
		// One answer can still come from the process that is shutting down.
		if (hits >= required) return true;
		await new Promise((r) => setTimeout(r, hits ? 500 : 1500));
	}
	return false;
}
