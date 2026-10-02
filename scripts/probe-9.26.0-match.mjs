import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const DIST = "/tmp/directus-9.26.0-api/dist";
const CATALOG = path.resolve(import.meta.dirname, "../catalog/patches");

const waiting = [
	"GHSA-97xr-jchp-xm3c",
	"GHSA-gwvv-rr68-cmv6",
	"GHSA-7vcx-mhxq-9j96",
	"GHSA-xw72-c69j-h2rj",
	"GHSA-j5h6-vqc3-phqh",
	"GHSA-7h45-q5jx-7r87",
	"GHSA-p623-wgx3-wxp8",
	"GHSA-ff8w-8crv-9rcf",
	"GHSA-5h38-6755-g83w",
];

function tryFile(rel) {
	const p = path.join(DIST, rel.replace(/^@directus\/api\/dist\//, ""));
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function loadOverlay(id) {
	for (const name of ["10.13.4.yml", "targets.yml"]) {
		const f = path.join(CATALOG, id, name);
		if (fs.existsSync(f)) return { name, targets: parseYaml(fs.readFileSync(f, "utf8")) };
	}
	return null;
}

for (const id of waiting) {
	const overlay = loadOverlay(id);
	console.log("\n==", id, overlay ? overlay.name : "NO OVERLAY");
	if (!overlay) continue;
	for (const t of overlay.targets) {
		const src = tryFile(t.file);
		if (src == null) {
			console.log("  MISSING", t.file);
			continue;
		}
		let ok = true;
		for (const [i, r] of (t.replace ?? []).entries()) {
			const n = src.split(r.from).length - 1;
			if (n !== 1) {
				ok = false;
				console.log(`  ${t.file}  from[${i}] matches=${n}`);
			}
		}
		if (ok) console.log("  MATCH", t.file);
	}
}

const probes = {
	"websocket/controllers/base.js": ["failed authentication", "client.accountability = null", "WebSocket"],
	"utils/sanitize-query.js": ["function sanitizeDeep", "const result = {}", "parse(level"],
	"services/assets.js": ["sharp.counters", "IllegalAssetTransformation", "ASSETS_TRANSFORM"],
	"controllers/utils.js": ["hash/generate", "ForbiddenError", "InvalidPayloadException", "@directus/errors", "@directus/exceptions"],
	"request/is-denied-ip.js": ["0.0.0.0", "ipInNetworks", "ipDenyList"],
	"services/shares.js": ["user_created", "async login", "checkAccess('share'"],
	"services/files.js": ["async uploadOne", "extractMetadata", "AuthorizationService"],
	"websocket/controllers/graphql.js": ["graphql-ws", "onSubscribe", "getSchema"],
	"services/mail/index.js": ["renderTemplate", "EMAIL_TEMPLATES_PATH", "InvalidPayload"],
	"utils/sanitize-query.js": ["sanitizeAggregate", "conceal"],
};

console.log("\n== snippet hunt ==");
for (const [file, needles] of Object.entries(probes)) {
	const src = tryFile(file);
	console.log(file, src ? `${src.length} bytes` : "MISSING");
	if (!src) continue;
	for (const n of needles) console.log("   ", JSON.stringify(n), src.includes(n));
}
