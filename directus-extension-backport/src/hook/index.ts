import { defineHook } from "@directus/extensions-sdk";
import { ensureDesiredApplied } from "../../../src/engine.js";
import { autoReapplyEnabled, catalogRoot, installFromEnv } from "../shared/runtime.js";

export default defineHook(({ init }, { logger }) => {
	init("app.before", async () => {
		if (!autoReapplyEnabled()) return;
		try {
			const catalog = catalogRoot();
			if (!catalog) {
				logger.warn(
					"[backport] no catalog yet — skip persist re-apply. Use Check for Updates (or cli.mjs catalog --refresh) first.",
				);
				return;
			}
			const result = await ensureDesiredApplied(installFromEnv(), catalog);
			if (result.error) {
				logger.warn(`[backport] ${result.error}`);
			}
			if (!result.wrote) return;
			logger.warn(
				`[backport] re-applied ${result.applied.join(", ")} from desired.json; exiting so the process loads patched files`,
			);
			process.exit(0);
		} catch (err) {
			logger.warn(`[backport] persist re-apply skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
});
