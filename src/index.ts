export {
	loadCatalog,
	partitionAdvisories,
	hasApplyablePatch,
	advisoryApplies,
	isStillVulnerable,
	statusForVersion,
	targetsForVersion,
} from "./catalog.js";
export { detectInstall, resolveNodeFile } from "./detect.js";
export { probeWriteAccess } from "./writable.js";
export {
	applyPatches,
	ensureDesiredApplied,
	rollbackLast,
	rollbackAll,
	rollbackSnapshot,
	rollbackAdvisory,
	statusReport,
	noteBootHealthy,
	noteBootStart,
	verifyInstall,
} from "./engine.js";
export { addDesiredIds, desiredPath, loadDesired, removeDesiredIds } from "./desired.js";
export { ping, waitForHealth } from "./health.js";
export { sha256 } from "./patch.js";
export { loadState } from "./state.js";
export { catalogRemoteStatus, refreshRemoteCatalog, resolveCatalogDir } from "./catalog-fetch.js";
export { verifyCatalogDir } from "./trust.js";
export type * from "./types.js";
