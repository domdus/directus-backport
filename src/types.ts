export type Severity = "critical" | "high" | "medium" | "low";

export type PortStatus =
	| "already-fixed"
	| "needs-port"
	| "experimental"
	| "stable"
	| "wont-port";

export type PortRisk = "none" | "low" | "medium" | "high";

export type Replacement = {
	from: string;
	to: string;
};

export type PatchTarget = {
	/** Path relative to node_modules, for example `@directus/api/dist/websocket.js`. */
	file: string;
	beforeSha256: string;
	afterSha256?: string;
	diff?: string;
	replace?: Replacement[];
	/** Exact Directus version this target is checksum-pinned to. Defaults to 11.17.4. */
	pin?: string;
};

export type PortInfo = {
	status: PortStatus;
	risk: PortRisk;
	notes?: string;
	sourceCommit?: string;
	targets: PatchTarget[];
};

export type Advisory = {
	id: string;
	title: string;
	severity: Severity;
	advisory: string;
	affects: string;
	upstreamPatched: string;
	port: PortInfo;
};

export type Catalog = {
	catalogVersion: number;
	updated?: string;
	notes?: string;
	advisories: Advisory[];
	source: string;
};

export type DirectusInstall = {
	root: string;
	nodeModules: string;
	version: string;
	directusPackage: string;
};

export type WriteAccess = {
	writable: boolean;
	snapshotWritable: boolean;
	nodeModulesWritable: boolean;
	reason?: string;
};

export type AppliedPatch = {
	id: string;
	at: string;
	snapshot: string;
	files: string[];
};

export type HealthStatus = "pending" | "ok" | "failed" | "rolled-back";

export type StateFile = {
	installVersion?: string;
	/** Path to desired.json so rollback can clear persisted ids even if cwd differs. */
	desiredFile?: string;
	applied: AppliedPatch[];
	last?: {
		action: "apply" | "rollback";
		at: string;
		snapshot: string;
		ids: string[];
		health: HealthStatus;
		error?: string;
	};
};

export type ApplyOptions = {
	ids: string[];
	yes?: boolean;
	healthUrl?: string;
	healthTimeoutMs?: number;
	restartCmd?: string;
	rollbackOnFail?: boolean;
	/** Write GHSA ids to desired.json (default true). Boot re-apply sets this false. */
	persistDesired?: boolean;
};

export type ApplyResult = {
	ok: boolean;
	applied: string[];
	snapshot?: string;
	health: HealthStatus;
	rolledBack: boolean;
	error?: string;
	files: string[];
};
