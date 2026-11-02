import { defineHook } from "@directus/extensions-sdk";
import { ensureDesiredApplied, noteBootHealthy, noteBootStart } from "../../../src/engine.js";
import { autoReapplyEnabled, catalogRoot, finishRestart, installFromEnv, pinExtensionRoot, workerCount } from "../shared/runtime.js";

export default defineHook(({ init, action }, { logger }) => {
	init("app.before", async () => {
		try {
			pinExtensionRoot();
			const catalog = catalogRoot();
			const install = installFromEnv();

			// One boot per worker is normal; only count past that as a failed start.
			const guard = noteBootStart(install, catalog, workerCount() + 2);
			if (guard.rolledBack.length) {
				logger.error(
					`[backport] Directus did not reach server start with ${guard.rolledBack.join(", ")}; rolled back, exiting to reload`,
				);
				process.exit(1);
			}

			if (!autoReapplyEnabled()) return;
			if (!catalog) {
				logger.warn(
					"[backport] no catalog yet — skip persist re-apply. Use Check for Updates (or dist/cli.mjs catalog --refresh) first.",
				);
				return;
			}
			const result = await ensureDesiredApplied(install, catalog, { preflight: true, guardBoot: true });
			if (result.error) {
				// This host is running without fixes the operator asked for.
				logger.error(`[backport] NOT APPLIED: ${result.error}`);
			}
			if (!result.wrote) return;
			logger.warn(
				`[backport] re-applied ${result.applied.join(", ")} from desired.json; exiting so the process loads patched files`,
			);
			process.exit(1);
		} catch (err) {
			logger.error(`[backport] persist re-apply skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	action("server.stop", () => finishRestart());

	action("server.start", () => {
		try {
			noteBootHealthy(installFromEnv());
		} catch (err) {
			logger.warn(`[backport] could not record a healthy boot: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
});
