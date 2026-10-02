export {
	loadCatalog,
	partitionAdvisories,
	hasApplyablePatch,
	advisoryApplies,
	isStillVulnerable,
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
	verifyInstall,
} from "./engine.js";
export { addDesiredIds, desiredPath, loadDesired, removeDesiredIds } from "./desired.js";
export { ping, waitForHealth } from "./health.js";
export { sha256 } from "./patch.js";
export { loadState } from "./state.js";
export { catalogRemoteStatus, refreshRemoteCatalog, resolveCatalogDir } from "./catalog-fetch.js";
export type * from "./types.js";
