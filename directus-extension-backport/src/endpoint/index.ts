import type { Request, Response, Router } from "express";
import { applyPatches, rollbackAdvisory, rollbackAll, rollbackLast, statusReport } from "../../../src/engine.js";
import {
	cliStatus,
	installHostCli,
	purgeWorkingFiles,
	rollbackCommands,
	uninstallHostCli,
} from "../../../src/cli-tools.js";
import { catalogRemoteStatus, refreshRemoteCatalog } from "../../../src/catalog-fetch.js";
import { accountabilityIsAdmin } from "../shared/admin.js";
import { catalogRoot, installFromEnv } from "../shared/runtime.js";

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
	const install = installFromEnv();
	const catalog = catalogRoot();
	const report = statusReport(install, catalog);
	const cli = cliStatus(install, catalog);
	const commands = rollbackCommands(catalog);
	return {
		install: {
			version: install.version,
			root: install.root,
			nodeModules: install.nodeModules,
		},
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
			const install = installFromEnv();
			res.json({
				data: {
					...cliStatus(install, catalogRoot()),
					catalogRemote: catalogRemoteStatus(),
				},
			});
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/catalog/refresh", async (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const result = await refreshRemoteCatalog();
			res.json({ data: result });
		} catch (err) {
			sendError(res, 502, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/tools/install-cli", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const result = installHostCli(installFromEnv(), catalogRoot());
			res.json({ data: result });
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/tools/uninstall-cli", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const result = uninstallHostCli(catalogRoot());
			res.json({ data: result });
		} catch (err) {
			sendError(res, 500, err instanceof Error ? err.message : String(err));
		}
	});

	router.post("/tools/purge-files", (req: Request, res: Response) => {
		if (!requireAdmin(req, res)) return;
		try {
			const result = purgeWorkingFiles(installFromEnv(), catalogRoot());
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
			const install = installFromEnv();
			const result = await applyPatches(
				install,
				{
					ids,
					rollbackOnFail: false,
				},
				catalogRoot(),
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
			const install = installFromEnv();
			const catalog = catalogRoot();
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
