import { Command } from "commander";
import { detectInstall } from "./detect.js";
import { applyPatches, rollbackAdvisory, rollbackAll, rollbackLast, rollbackSnapshot, statusReport, verifyInstall } from "./engine.js";
import { loadDesired } from "./desired.js";
import { hasApplyablePatch, isFixedOnThisVersion, isStillVulnerable, loadCatalog } from "./catalog.js";
import { catalogRemoteStatus, refreshRemoteCatalog, resolveCatalogDir } from "./catalog-fetch.js";
import { hasLocalCatalog } from "./catalog-source.js";
import { findPackageRoot } from "./paths.js";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Advisory, DirectusInstall } from "./types.js";

function cancelIf<T>(value: T): asserts value is Exclude<T, symbol> {
	if (p.isCancel(value)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
}

function resolveInstall(root?: string): DirectusInstall {
	return detectInstall(root);
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusLabel(advisory: Advisory, version?: string): string {
	if (version && isFixedOnThisVersion(advisory, version)) {
		return pc.green(`already in ${advisory.upstreamPatched}+`);
	}
	if (version && isStillVulnerable(advisory, version)) {
		if (hasApplyablePatch(advisory, version)) return pc.yellow("experimental");
		return pc.dim("needs-port");
	}
	const s = advisory.port.status;
	if (s === "stable") return pc.green("stable");
	if (s === "experimental") return pc.yellow("experimental");
	if (s === "needs-port") return pc.dim("needs-port");
	if (s === "already-fixed") return pc.green(`already in ${advisory.upstreamPatched}+`);
	return pc.dim(s);
}

/** Action-oriented summary for operators — omit catalog gaps the host cannot act on. */
function formatStatusCounts(counts: {
	applied: number;
	ready: number;
	alreadyFixed: number;
}): string {
	const parts = [`${pc.bold(String(counts.applied))} applied`, `${pc.bold(String(counts.ready))} ready to apply`];
	if (counts.alreadyFixed > 0) {
		parts.push(`${pc.bold(String(counts.alreadyFixed))} already fixed upstream`);
	}
	return parts.join(" · ");
}

export async function interactive(
	install: DirectusInstall,
	opts: { healthUrl?: string; restartCmd?: string },
): Promise<void> {
	p.intro(pc.bgBlue(pc.white(" directus-backport ")));
	p.log.message(
		`${pc.dim("This is a patch catalog, not a Directus distro.")}\n${pc.dim("Official fix = upgrade to the patched 12.x release. These are optional, reversible stopgaps.")}`,
	);

	const report = statusReport(install);
	p.log.info(`Directus ${pc.bold(install.version)}\n${pc.dim(install.nodeModules)}`);
	p.log.message(formatStatusCounts(report.counts));

	if (report.catalogMissing) {
		p.outro(`No catalog yet. Opt in: ${pc.bold("directus-backport catalog --refresh")} (or Studio Check for Updates).`);
		return;
	}

	if (report.last?.health === "failed") {
		p.log.error(`Last apply failed health check. Run ${pc.bold("directus-backport rollback")} if Studio is down.`);
	}

	if (report.ready.length === 0) {
		if (report.counts.applied) {
			p.outro(`${pc.bold(String(report.counts.applied))} already applied on this install.`);
			return;
		}
		p.outro("Nothing ready to apply for this version.");
		return;
	}

	const selected = await p.multiselect({
		message: "Apply which backports?",
		options: report.ready.map((a) => ({
			value: a.id,
			label: `${a.id}  ${a.severity}  ${statusLabel(a, install.version)}`,
			hint: a.title,
		})),
		required: false,
	});
	cancelIf(selected);

	if (!Array.isArray(selected) || selected.length === 0) {
		p.outro("Nothing selected.");
		return;
	}

	const chosen = report.ready.filter((a) => selected.includes(a.id));
	p.note(
		chosen.map((a) => `${a.id}  risk=${a.port.risk}\n${a.port.notes ?? a.title}`).join("\n\n"),
		"Will snapshot these files first",
	);

	const go = await p.confirm({
		message: `Snapshot node_modules and apply ${chosen.length} patch(es)?`,
		initialValue: true,
	});
	cancelIf(go);
	if (!go) {
		p.outro("Nothing applied.");
		return;
	}

	const rollbackOnFail = await p.confirm({
		message: "If Directus fails to boot, auto-rollback the snapshot?",
		initialValue: true,
	});
	cancelIf(rollbackOnFail);

	const healthUrl = await p.text({
		message: "Health URL (empty to skip boot check)",
		placeholder: opts.healthUrl ?? "http://127.0.0.1:8055/server/ping",
		defaultValue: opts.healthUrl ?? "",
	});
	cancelIf(healthUrl);

	const restartCmd = await p.text({
		message: "Restart command (empty to skip — you restart yourself)",
		placeholder: opts.restartCmd ?? "docker compose restart directus",
		defaultValue: opts.restartCmd ?? "",
	});
	cancelIf(restartCmd);

	const spin = p.spinner();
	spin.start("Applying patches…");
	const result = await applyPatches(install, {
		ids: chosen.map((a) => a.id),
		healthUrl: healthUrl.trim() || undefined,
		restartCmd: restartCmd.trim() || undefined,
		rollbackOnFail: Boolean(rollbackOnFail),
	});
	spin.stop(result.ok ? "Done" : "Failed");

	if (result.rolledBack) {
		p.log.error(result.error ?? "Rolled back after failure.");
		p.outro("Install restored from snapshot. Directus files are back to the previous bytes.");
		process.exitCode = 1;
		return;
	}
	if (!result.ok) {
		p.log.error(result.error ?? "Apply failed.");
		p.outro(
			`Snapshot kept at .directus-backport/snapshots/${result.snapshot}. Run ${pc.bold("directus-backport rollback")} if needed.`,
		);
		process.exitCode = 1;
		return;
	}

	if (result.health === "pending") {
		p.note(
			[
				"Patches are on disk. Restart Directus, then:",
				"  directus-backport verify --health-url http://HOST/server/ping",
				"If it never comes back:",
				"  directus-backport rollback",
				"That command does not need Directus to be running.",
			].join("\n"),
			"Restart required",
		);
	}
	p.outro(pc.green(`Applied ${result.applied.join(", ")}`));
}

export function createProgram(): Command {
	const program = new Command();
	program
		.name("directus-backport")
		.description("Apply reversible Directus 9.26.0 / 10.13.4 / 11.17.4 security backports from a catalog. Not a Directus fork. No command = prompt UI.")
		.version("0.1.0")
		.option("-r, --root <path>", "Directus install (optional; discovered from cwd, this CLI, or /directus)")
		.option("--json", "JSON output", false);

	program
		.command("status")
		.description("Show this install vs the catalog")
		.action(async () => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			const report = statusReport(install);
			if (opts.json) {
				printJson(report);
				return;
			}
			p.intro("directus-backport status");
			p.log.info(`Directus ${install.version}\n${install.nodeModules}`);
			p.log.message(formatStatusCounts(report.counts));
			if (report.catalogMissing) {
				p.outro(`No catalog yet. Opt in: ${pc.bold("directus-backport catalog --refresh")}.`);
				return;
			}
			if (report.last) {
				p.log.message(`Last ${report.last.action}  health=${report.last.health}  snapshot=${report.last.snapshot}`);
			}
			if (report.desired.ids.length) {
				p.log.message(`Persisted ${report.desired.ids.length} in desired.json (${report.desiredFile})`);
			}
			if (report.ready.length) {
				p.note(report.ready.map((a) => `${a.id}  ${a.severity}  ${statusLabel(a, install.version)}`).join("\n"), "Ready to apply");
			}
			p.outro(
				report.counts.ready
					? `Run ${pc.bold("directus-backport")} to apply interactively.`
					: report.counts.applied
						? `${report.counts.applied} applied on this install.`
						: "Nothing to do for this version.",
			);
		});

	program
		.command("catalog")
		.description("Show this install vs the catalog (use --all for the full registry)")
		.option("--refresh", "Download the GitHub catalog into the local cache (does not apply patches)", false)
		.option("--all", "List every advisory in the registry (maintainer view)", false)
		.action(async (cmdOpts: { refresh?: boolean; all?: boolean }) => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			if (cmdOpts.refresh) {
				try {
					const result = await refreshRemoteCatalog();
					if (opts.json) {
						printJson(result);
						return;
					}
					p.intro("directus-backport catalog --refresh");
					p.log.success(`Fetched ${result.github}@${result.ref} (${result.files} files)`);
					p.log.message(pc.dim(result.cacheDir));
					p.log.message(pc.dim("Nothing was applied. This only updates the local catalog cache."));
				} catch (err) {
					process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
					process.exitCode = 1;
					return;
				}
			} else if (!hasLocalCatalog()) {
				if (opts.json) {
					printJson({ remote: catalogRemoteStatus(), catalogMissing: true });
					return;
				}
				p.intro("directus-backport catalog");
				p.outro(`No catalog yet. Opt in: ${pc.bold("directus-backport catalog --refresh")}.`);
				return;
			}

			let install: DirectusInstall | null = null;
			try {
				install = resolveInstall(opts.root);
			} catch {
				install = null;
			}

			if (opts.json && !cmdOpts.refresh) {
				const catalog = loadCatalog();
				printJson(
					install
						? { remote: catalogRemoteStatus(), ...statusReport(install) }
						: { remote: catalogRemoteStatus(), ...catalog },
				);
				return;
			}

			if (!install) {
				const catalog = loadCatalog();
				const remote = catalogRemoteStatus();
				p.intro("directus-backport catalog");
				p.log.message(`Source  ${remote.using}  ${pc.dim(catalog.source)}`);
				p.outro("No Directus install detected. Pass --root, or use --all to dump the registry.");
				return;
			}

			const report = statusReport(install);
			const remote = catalogRemoteStatus();

			if (!cmdOpts.refresh) {
				p.intro("directus-backport catalog");
			}
			p.log.info(`Directus ${pc.bold(install.version)}\n${pc.dim(install.nodeModules)}`);
			p.log.message(`Catalog  ${remote.using}${remote.fetchedAt ? `  fetched ${remote.fetchedAt}` : ""}`);
			p.log.message(pc.dim(remote.advisories));
			p.log.message(formatStatusCounts(report.counts));

			if (report.ready.length) {
				p.note(
					report.ready.map((a) => `${a.id}  ${a.severity}  ${a.title}`).join("\n"),
					"Ready to apply",
				);
			}

			if (cmdOpts.all) {
				const catalog = loadCatalog();
				const applied = new Set(report.appliedIds);
				p.note(
					catalog.advisories
						.map((a) => {
							const tag = applied.has(a.id) ? "applied" : statusLabel(a, install.version);
							return `${a.id}  ${a.severity}  ${tag}  ${a.title}`;
						})
						.join("\n"),
					"Full registry",
				);
			}

			p.outro(
				report.counts.ready
					? `Run ${pc.bold("directus-backport apply --all --yes")} to apply the ready set.`
					: report.counts.applied
						? "This install is up to date with the catalog it is using."
						: "Nothing to do for this version.",
			);
		});

	program
		.command("apply")
		.description("Apply one or more GHSA backports (non-interactive with --yes)")
		.argument("[ids...]", "GHSA ids")
		.option("-y, --yes", "Do not prompt", false)
		.option("--all", "Apply every ready backport for this version", false)
		.option("--desired", "Use GHSA ids from desired.json (next to the catalog, or DIRECTUS_BACKPORT_DESIRED)", false)
		.option("--health-url <url>", "GET this URL after apply until it returns 2xx")
		.option("--restart-cmd <cmd>", "Shell command to restart Directus after apply")
		.option("--no-rollback-on-fail", "Do not restore the snapshot if health/restart fails")
		.option("--health-timeout <ms>", "Health wait timeout", "90000")
		.action(async (ids: string[], cmdOpts: {
			yes?: boolean;
			all?: boolean;
			desired?: boolean;
			rollbackOnFail?: boolean;
			healthTimeout?: string;
			healthUrl?: string;
			restartCmd?: string;
		}) => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			if (!hasLocalCatalog()) {
				process.stderr.write("No catalog yet. Opt in: directus-backport catalog --refresh\n");
				process.exitCode = 1;
				return;
			}
			if (!cmdOpts.yes && !cmdOpts.all) {
				await interactive(install, { healthUrl: cmdOpts.healthUrl, restartCmd: cmdOpts.restartCmd });
				return;
			}
			if (cmdOpts.all && (ids.length || cmdOpts.desired)) {
				process.stderr.write("Use --all alone, not with GHSA ids or --desired.\n");
				process.exitCode = 1;
				return;
			}
			if (cmdOpts.all) {
				ids = statusReport(install).ready.map((a) => a.id);
				if (!ids.length) {
					process.stdout.write("No ready backports\n");
					return;
				}
			} else if (!ids.length && cmdOpts.desired) {
				ids = loadDesired().ids;
				if (!ids.length) {
					process.stdout.write("desired.json has no ids\n");
					return;
				}
			}
			if (!ids.length) {
				process.stderr.write("Pass GHSA ids, --all, --desired, or run without --yes for the prompt UI.\n");
				process.exitCode = 1;
				return;
			}
			const result = await applyPatches(install, {
				ids,
				yes: true,
				healthUrl: cmdOpts.healthUrl,
				restartCmd: cmdOpts.restartCmd,
				rollbackOnFail: cmdOpts.rollbackOnFail,
				healthTimeoutMs: Number(cmdOpts.healthTimeout),
			});
			if (opts.json) printJson(result);
			else if (result.ok) process.stdout.write(`applied ${result.applied.join(", ")}\n`);
			else process.stderr.write(`${result.error}\n`);
			if (!result.ok) process.exitCode = 1;
		});

	program
		.command("rollback")
		.description("Restore the most recently applied backport (works even if Directus is down)")
		.option("--snapshot <id>", "Specific snapshot id")
		.option("--id <ghsa>", "Rollback one advisory")
		.option("--all", "Rollback every applied backport")
		.action(async (cmdOpts: { snapshot?: string; id?: string; all?: boolean }) => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			const catalogDir = resolveCatalogDir();
			const result = cmdOpts.all
				? rollbackAll(install, catalogDir)
				: cmdOpts.id
					? rollbackAdvisory(install, cmdOpts.id, catalogDir)
					: cmdOpts.snapshot
						? rollbackSnapshot(install, cmdOpts.snapshot, catalogDir)
						: rollbackLast(install, catalogDir);
			if (opts.json) printJson(result);
			else process.stdout.write(`restored snapshot ${result.snapshot} (${result.files.length} files)\n`);
		});

	program
		.command("verify")
		.description("Ping a health URL and record the result")
		.requiredOption("--health-url <url>")
		.option("--timeout <ms>", "Timeout", "30000")
		.action(async (cmdOpts: { healthUrl: string; timeout?: string }) => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			const result = await verifyInstall(install, cmdOpts.healthUrl, Number(cmdOpts.timeout));
			if (opts.json) printJson(result);
			else process.stdout.write(result.ok ? "healthy\n" : "unhealthy\n");
			if (!result.ok) process.exitCode = 1;
		});

	program
		.command("doctor")
		.description("Sanity-check install, catalog, and last snapshot")
		.action(async () => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			const report = statusReport(install);
			const pkg = findPackageRoot();
			const catalog = catalogRemoteStatus();
			if (opts.json) {
				printJson({
					packageRoot: pkg,
					install,
					catalog,
					counts: report.counts,
					last: report.last,
					write: report.write,
					desired: report.desired,
					desiredFile: report.desiredFile,
					catalogMissing: report.catalogMissing,
				});
				return;
			}
			p.intro("directus-backport doctor");
			p.log.info(`CLI package  ${pkg}`);
			p.log.info(`Directus     ${install.version} @ ${install.nodeModules}`);
			p.log.info(`Catalog      ${catalog.using} ${catalog.advisories ?? "(none — run catalog --refresh)"}`);
			p.log.info(`Open ${report.counts.open} · ready ${report.counts.ready} · applied ${report.counts.applied}`);
			if (report.catalogMissing) {
				p.log.warn("No catalog yet. Opt in with catalog --refresh (or Studio Check for Updates).");
			}
			if (!report.write.writable) {
				p.log.warn(report.write.reason || "This process cannot write node_modules.");
			}
			if (report.last?.health === "failed") {
				p.log.warn("Last apply failed health. Rollback from this CLI — Directus does not need to be up.");
			}
			p.outro("If Studio is dead after a patch: node /directus/extensions/directus-extension-backport/cli.mjs rollback");
		});

	program
		.command("tui", { isDefault: true, hidden: true })
		.description("Interactive prompt UI")
		.action(async () => {
			const opts = program.opts<{ root?: string; json?: boolean }>();
			const install = resolveInstall(opts.root);
			if (opts.json) {
				printJson(statusReport(install));
				return;
			}
			await interactive(install, {});
		});

	return program;
}
