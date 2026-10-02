import type { Request, Response, Router } from "express";
import { applyPatches, rollbackAdvisory, rollbackAll, rollbackLast, statusReport } from "../../../src/engine.js";
import { cliStatus, purgeWorkingFiles, rollbackCommands } from "../../../src/cli-tools.js";
import { catalogRemoteStatus, refreshRemoteCatalog } from "../../../src/catalog-fetch.js";
import { accountabilityIsAdmin } from "../shared/admin.js";
import { catalogRoot, installFromEnv, pinExtensionRoot } from "../shared/runtime.js";
import { checkForUpdates } from "./update-check.js";

function requireAdmin(req: Request, res: Response): boolean {
	if (!accountabilityIsAdmin((req as { accountability?: unknown }).accountability)) {
		res.status(403).json({
			errors: [{ message: "Admin access required", extensions: { code: "FORBIDDEN" } }],
		});
		return false;
	}
	return true;
}

function sendError(res: Response, status: number, message: string) {
	res.status(status).json({ errors: [{ message }] });
}

function exitAfterResponse(res: Response) {
	res.on("finish", () => {
		setTimeout(() => process.exit(0), 250);
	});
}

function publicReport() {
	const packageRoot = pinExtensionRoot();
	const install = installFromEnv();
	const catalog = catalogRoot();
	const report = statusReport(install, catalog);
	const tools = { packageRoot, catalogRoot: catalog };
	const cli = cliStatus(install, tools);
	const commands = rollbackCommands(tools);
	return {
		install: {
			version: install.version,
			root: install.root,
			nodeModules: install.nodeModules,
		},
		catalogMissing: report.catalogMissing,
		counts: report.counts,
		last: report.last,
		applied: report.applied,
		appliedCatalog: report.applied.map((row) => {
			const advisory = report.appliedCatalog.find((item) => item.id === row.id);
			if (!advisory) return null;
			const snapshotIds = report.applied.filter((item) => item.snapshot === row.snapshot).map((item) => item.id);
			return { ...publicAdvisory(advisory), snapshot: row.snapshot, snapshotIds };
		}).filter(Boolean),
		lastApplyIds: report.lastApplyIds,
		write: report.write,
		desired: report.desired,
		desiredFile: report.desiredFile,
		open: report.open.map(publicAdvisory),
		ready: report.ready.map(publicAdvisory),
		waiting: report.waiting.map(publicAdvisory),
		alreadyFixed: report.alreadyFixed.map(publicAdvisory),
		cli,
		rollbackCli: commands.cli,
		rollbackDocker: commands.docker,
		rollbackHint: `${commands.cli}\n\n${commands.docker}`,
		catalogRemote: catalogRemoteStatus(),
	};
}

function publicAdvisory(a: {
	id: string;
	title: string;
	severity: string;
	advisory: string;
	affects: string;
	upstreamPatched: string;
	port: { status: string; risk: string; notes?: string };
}) {
	return {
		id: a.id,
		title: a.title,
		severity: a.severity,
		advisory: a.advisory,
		affects: a.affects,
		upstreamPatched: a.upstreamPatched,
		port: a.port,
	};
}

export default (router: Router) => {
	router.get("/", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			res.json({ data: publicReport() });
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.get("/tools", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const packageRoot = pinExtensionRoot();
			const install = installFromEnv();
			const catalog = catalogRoot();
			res.json({
				data: {
					...cliStatus(install, { packageRoot, catalogRoot: catalog }),
					catalogRemote: catalogRemoteStatus(),
					catalogMissing: !catalog,
				},
			});
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.get("/update-check", async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const force = req.query.force === "1" || req.query.force === "true";
			const data = await checkForUpdates(force);
			res.json({ data });
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/catalog/refresh", async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			pinExtensionRoot();
			const result = await refreshRemoteCatalog();
			res.json({ data: result });
		} catch (err) {
			sendError(res, 502, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/tools/purge-files", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const packageRoot = pinExtensionRoot();
			const result = purgeWorkingFiles(installFromEnv(), {
				packageRoot,
				catalogRoot: catalogRoot(),
			});
			res.json({ data: result });
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/apply", async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
		if (ids.length === 0) {
			sendError(res, 400, "ids is required");
			return;
		}
		try {
			pinExtensionRoot();
			const catalog = catalogRoot();
			if (!catalog) {
				sendError(res, 409, "No catalog yet. Use Check for Updates first (does not apply patches).");
				return;
			}
			const install = installFromEnv();
			const result = await applyPatches(
				install,
				{
					ids,
					rollbackOnFail: false,
				},
				catalog,
			);
			if (!result.ok) {
				sendError(res, 409, result.error || "Apply failed");
				return;
			}
			res.json({
				data: {
					...result,
					restarting: true,
					note: "Directus process will exit so a supervisor (or you) can start it again with the patched files. If it never comes back, run the bundled CLI rollback from the host.",
				},
			});
			exitAfterResponse(res);
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/rollback", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			pinExtensionRoot();
			const catalog = catalogRoot();
			const install = installFromEnv();
			const all = req.body?.all === true;
			const id = req.body?.id ? String(req.body.id) : "";
			const result = all
				? rollbackAll(install, catalog)
				: id
					? rollbackAdvisory(install, id, catalog)
					: rollbackLast(install, catalog);
			res.json({ data: { ...result, restarting: true } });
			exitAfterResponse(res);
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});
};
