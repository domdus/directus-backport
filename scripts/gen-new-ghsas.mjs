import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CATALOG = path.resolve(import.meta.dirname, "../catalog");
const DIST = {
	"11.17.4": "/tmp/dx-bp/api-11/dist",
	"10.13.4": "/tmp/dx-bp/api-10/dist",
	"9.26.0": "/tmp/dx-bp/api-9/dist",
};

function sha(s) {
	return createHash("sha256").update(s).digest("hex");
}

function read(pin, rel) {
	return fs.readFileSync(path.join(DIST[pin], rel), "utf8");
}

function apply(src, replace) {
	let next = src;
	for (const { from, to } of replace) {
		const n = next.split(from).length - 1;
		if (n !== 1) throw new Error(`from matched ${n} times:\n${from.slice(0, 240)}`);
		next = next.split(from).join(to);
	}
	if (next === src) throw new Error("no changes");
	return next;
}

function overlayName(pin) {
	if (pin === "11.17.4") return "targets.yml";
	return `${pin}.yml`;
}

function writeOverlay(id, pin, entries) {
	const dir = path.join(CATALOG, "patches", id);
	fs.mkdirSync(dir, { recursive: true });
	const doc = entries.map(({ file, src, replace }) => {
		const after = apply(src, replace);
		return {
			file: `@directus/api/dist/${file}`,
			before_sha256: sha(src),
			after_sha256: sha(after),
			replace,
		};
	});
	const yaml = doc
		.map((t) => {
			let s = `- file: ${JSON.stringify(t.file)}\n`;
			s += `  before_sha256: ${JSON.stringify(t.before_sha256)}\n`;
			s += `  after_sha256: ${JSON.stringify(t.after_sha256)}\n`;
			s += `  replace:\n`;
			for (const r of t.replace) {
				s += `    - from: ${JSON.stringify(r.from)}\n`;
				s += `      to: ${JSON.stringify(r.to)}\n`;
			}
			return s;
		})
		.join("");
	fs.writeFileSync(path.join(dir, overlayName(pin)), yaml);
	console.log(id, pin, "ok", doc.length, "file(s)");
}

function setDeepHelper(indent, quote) {
	const lines = [
		"function setDeepSafe(root, path, value) {",
		`${indent}const segments = String(path).split(${quote}.${quote});`,
		`${indent}if (!segments.length || segments.some((s) => s.length === 0)) return root;`,
		`${indent}const assignOwn = (obj, key, val) => {`,
		`${indent}${indent}Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });`,
		`${indent}};`,
		`${indent}let node = root;`,
		`${indent}for (let i = 0; i < segments.length - 1; i++) {`,
		`${indent}${indent}const key = segments[i];`,
		`${indent}${indent}if (!Object.prototype.hasOwnProperty.call(node, key) || typeof node[key] !== ${quote}object${quote} || node[key] === null) assignOwn(node, key, Object.create(null));`,
		`${indent}${indent}node = node[key];`,
		`${indent}}`,
		`${indent}assignOwn(node, segments[segments.length - 1], value);`,
		`${indent}return root;`,
		"}",
	];
	return lines.join("\n");
}

function storageGuardToArray(indent, quote, errorExpr) {
	const q = quote;
	return [
		`function assertValidStoragePath(filepath, storage) {`,
		`${indent}if (!filepath) return;`,
		`${indent}const location = storage || toArray(env[${q}STORAGE_LOCATIONS${q}])[0];`,
		`${indent}if (!location) return;`,
		`${indent}const loc = String(location).toUpperCase();`,
		`${indent}const driver = env[${q}STORAGE_${q} + loc + ${q}_DRIVER${q}];`,
		`${indent}const storageRoot = env[${q}STORAGE_${q} + loc + ${q}_ROOT${q}] ?? ${q}${q};`,
		`${indent}const sanitize = (p) => path.relative(path.sep, path.resolve(path.sep, String(p ?? ${q}${q}))).split(path.sep).join(${q}/${q});`,
		`${indent}const normalizedFilePath = sanitize(filepath);`,
		`${indent}const filePath = driver === ${q}local${q} ? sanitize(path.join(String(storageRoot), normalizedFilePath)) : normalizedFilePath;`,
		`${indent}const extensionPath = sanitize(env[${q}EXTENSIONS_PATH${q}] ?? ${q}./extensions${q});`,
		`${indent}const blocked = (base) => base && (filePath === base || filePath.startsWith(base + ${q}/${q}));`,
		`${indent}if (env[${q}EXTENSIONS_LOCATION${q}] && env[${q}EXTENSIONS_LOCATION${q}] === location && blocked(extensionPath)) throw ${errorExpr};`,
		`${indent}if (driver === ${q}local${q}) {`,
		`${indent}${indent}const tmpPath = sanitize(env[${q}TEMP_PATH${q}] ?? ${q}./temp${q});`,
		`${indent}${indent}if (blocked(extensionPath) || blocked(tmpPath)) throw ${errorExpr};`,
		`${indent}}`,
		`}`,
	].join("\n");
}

// --- GHSA-32cw-mf7w-gpqr CSV prototype pollution ---
{
	const src = read("11.17.4", "services/import-export.js");
	writeOverlay("GHSA-32cw-mf7w-gpqr", "11.17.4", [
		{
			file: "services/import-export.js",
			src,
			replace: [
				{
					from: 'const env = useEnv();\nconst logger = useLogger();\nconst MAX_IMPORT_ERRORS = env["MAX_IMPORT_ERRORS"];',
					to: `const env = useEnv();\nconst logger = useLogger();\nconst MAX_IMPORT_ERRORS = env["MAX_IMPORT_ERRORS"];\n${setDeepHelper("\t", '"')}`,
				},
				{
					from: "\t\t\t\t\t\t\tconst result = {};\n\t\t\t\t\t\t\tfor (const field in obj) if (obj[field] !== void 0) set(result, field, obj[field]);",
					to: "\t\t\t\t\t\t\tconst result = Object.create(null);\n\t\t\t\t\t\t\tfor (const field in obj) if (obj[field] !== void 0) setDeepSafe(result, field, obj[field]);",
				},
			],
		},
	]);
}

{
	const src = read("10.13.4", "services/import-export.js");
	writeOverlay("GHSA-32cw-mf7w-gpqr", "10.13.4", [
		{
			file: "services/import-export.js",
			src,
			replace: [
				{
					from: "const env = useEnv();\nconst logger = useLogger();\nexport class ImportService {",
					to: `const env = useEnv();\nconst logger = useLogger();\n${setDeepHelper("    ", "'")}\nexport class ImportService {`,
				},
				{
					from: `                        for (const field in obj) {
                            if (obj[field] === undefined) {
                                delete obj[field];
                            }
                        }
                        saveQueue.push(obj);`,
					to: `                        const result = Object.create(null);
                        for (const field in obj) {
                            if (obj[field] !== undefined) {
                                setDeepSafe(result, field, obj[field]);
                            }
                        }
                        saveQueue.push(result);`,
				},
			],
		},
	]);
}

{
	const src = read("9.26.0", "services/import-export.js");
	writeOverlay("GHSA-32cw-mf7w-gpqr", "9.26.0", [
		{
			file: "services/import-export.js",
			src,
			replace: [
				{
					from: "import { FilesService } from './files.js';\nimport { ItemsService } from './items.js';\nimport { NotificationsService } from './notifications.js';\nexport class ImportService {",
					to: `import { FilesService } from './files.js';\nimport { ItemsService } from './items.js';\nimport { NotificationsService } from './notifications.js';\n${setDeepHelper("    ", "'")}\nexport class ImportService {`,
				},
				{
					from: `                    const obj = transform(value, (result, value, key) => {
                        if (value.length === 0) {
                            delete result[key];
                        }
                        else {
                            try {
                                const parsedJson = parseJSON(value);
                                if (typeof parsedJson === 'number') {
                                    set(result, key, value);
                                }
                                else {
                                    set(result, key, parsedJson);
                                }
                            }
                            catch {
                                set(result, key, value);
                            }
                        }
                    });`,
					to: `                    const obj = transform(value, (result, value, key) => {
                        if (value.length === 0) {
                            delete result[key];
                        }
                        else {
                            try {
                                const parsedJson = parseJSON(value);
                                if (typeof parsedJson === 'number') {
                                    setDeepSafe(result, key, value);
                                }
                                else {
                                    setDeepSafe(result, key, parsedJson);
                                }
                            }
                            catch {
                                setDeepSafe(result, key, value);
                            }
                        }
                    }, Object.create(null));`,
				},
			],
		},
	]);
}

// --- GHSA-95f8-mvw7-gpj9 file write into extensions ---
{
	const src = read("11.17.4", "services/files.js");
	const tus = read("11.17.4", "services/tus/data-store.js");
	const guard = storageGuardToArray("\t", '"', "new ForbiddenError()");
	writeOverlay("GHSA-95f8-mvw7-gpj9", "11.17.4", [
		{
			file: "services/files.js",
			src,
			replace: [
				{
					from: "const env = useEnv();\nconst logger = useLogger();\nvar FilesService = class FilesService extends ItemsService {",
					to: `const env = useEnv();\nconst logger = useLogger();\n${guard}\nvar FilesService = class FilesService extends ItemsService {`,
				},
				{
					from: "\t\t\tdata.filename_disk = this.generateFilenamePath(data.filename_disk);\n\t\t\ttry {\n\t\t\t\tawait this.checkUniqueFilename(data.filename_disk);",
					to: "\t\t\tdata.filename_disk = this.generateFilenamePath(data.filename_disk);\n\t\t\tassertValidStoragePath(data.filename_disk, data.storage);\n\t\t\ttry {\n\t\t\t\tawait this.checkUniqueFilename(data.filename_disk);",
				},
				{
					from: "\t\t\tdata.filename_disk = this.generateFilenamePath(data.filename_disk);\n\t\t\ttry {\n\t\t\t\tawait this.checkUniqueFilename(data.filename_disk, keys[0]);",
					to: "\t\t\tdata.filename_disk = this.generateFilenamePath(data.filename_disk);\n\t\t\tassertValidStoragePath(data.filename_disk, data.storage);\n\t\t\ttry {\n\t\t\t\tawait this.checkUniqueFilename(data.filename_disk, keys[0]);",
				},
				{
					from: "\t\tpayload.filename_disk ||= filenameDisk;",
					to: "\t\tpayload.filename_disk ||= filenameDisk;\n\t\tassertValidStoragePath(payload.filename_disk, payload.storage);",
				},
			],
		},
		{
			file: "services/tus/data-store.js",
			src: tus,
			replace: [
				{
					from: 'import { extname } from "node:path";',
					to: 'import path, { extname } from "node:path";\nimport { useEnv } from "@directus/env";\nimport { toArray } from "@directus/utils";',
				},
				{
					from: "var TusDataStore = class extends DataStore {",
					to: `const env = useEnv();\n${storageGuardToArray("\t", '"', "ERRORS.INVALID_METADATA")}\nvar TusDataStore = class extends DataStore {`,
				},
				{
					from: '\t\tfileData.filename_disk ||= primaryKey + (fileExtension || "");',
					to: '\t\tfileData.filename_disk ||= primaryKey + (fileExtension || "");\n\t\tassertValidStoragePath(fileData.filename_disk, this.location);',
				},
			],
		},
	]);
}

{
	const src = read("10.13.4", "services/files.js");
	const tus = read("10.13.4", "services/tus/data-store.js");
	writeOverlay("GHSA-95f8-mvw7-gpj9", "10.13.4", [
		{
			file: "services/files.js",
			src,
			replace: [
				{
					from: "const env = useEnv();\nconst logger = useLogger();\nexport class FilesService extends ItemsService {",
					to: `const env = useEnv();\nconst logger = useLogger();\n${storageGuardToArray("    ", "'", "new ForbiddenError()")}\nexport class FilesService extends ItemsService {`,
				},
				{
					from: '        if (!data.type) {\n            throw new InvalidPayloadError({ reason: `"type" is required` });\n        }\n        const key = await super.createOne(data, opts);',
					to: '        if (!data.type) {\n            throw new InvalidPayloadError({ reason: `"type" is required` });\n        }\n        assertValidStoragePath(data.filename_disk, data.storage);\n        const key = await super.createOne(data, opts);',
				},
				{
					from: "        payload.filename_disk ||= primaryKey + (fileExtension || '');",
					to: "        payload.filename_disk ||= primaryKey + (fileExtension || '');\n        assertValidStoragePath(payload.filename_disk, payload.storage);",
				},
			],
		},
		{
			file: "services/tus/data-store.js",
			src: tus,
			replace: [
				{
					from: "import { extname } from 'node:path';",
					to: "import path, { extname } from 'node:path';\nimport { useEnv } from '@directus/env';\nimport { toArray } from '@directus/utils';",
				},
				{
					from: "export class TusDataStore extends DataStore {",
					to: `const env = useEnv();\n${storageGuardToArray("    ", "'", "ERRORS.INVALID_METADATA")}\nexport class TusDataStore extends DataStore {`,
				},
				{
					from: "        fileData.filename_disk ||= primaryKey + (fileExtension || '');",
					to: "        fileData.filename_disk ||= primaryKey + (fileExtension || '');\n        assertValidStoragePath(fileData.filename_disk, this.location);",
				},
			],
		},
	]);
}

{
	const src = read("9.26.0", "services/files.js");
	writeOverlay("GHSA-95f8-mvw7-gpj9", "9.26.0", [
		{
			file: "services/files.js",
			src,
			replace: [
				{
					from: "import { ItemsService } from './items.js';\nexport class FilesService extends ItemsService {",
					to: `import { ItemsService } from './items.js';\n${storageGuardToArray("    ", "'", "new ForbiddenException()")}\nexport class FilesService extends ItemsService {`,
				},
				{
					from: '        if (!data.type) {\n            throw new InvalidPayloadException(`"type" is required`);\n        }\n        const key = await super.createOne(data, opts);',
					to: '        if (!data.type) {\n            throw new InvalidPayloadException(`"type" is required`);\n        }\n        assertValidStoragePath(data.filename_disk, data.storage);\n        const key = await super.createOne(data, opts);',
				},
			],
		},
	]);
}

// --- GHSA-2xcm-7h22-3m66 getKeysByQuery ---
{
	const src = read("11.17.4", "services/items.js");
	writeOverlay("GHSA-2xcm-7h22-3m66", "11.17.4", [
		{
			file: "services/items.js",
			src,
			replace: [
				{
					from: "\t\treturn (await new ItemsService(this.collection, {\n\t\t\tknex: this.knex,\n\t\t\tschema: this.schema\n\t\t}).readByQuery(readQuery)).map((item) => item[primaryKeyField]).filter((pk) => pk);",
					to: "\t\treturn (await this.readByQuery(readQuery)).map((item) => item[primaryKeyField]).filter((pk) => pk);",
				},
			],
		},
	]);
}

{
	const src = read("10.13.4", "services/items.js");
	writeOverlay("GHSA-2xcm-7h22-3m66", "10.13.4", [
		{
			file: "services/items.js",
			src,
			replace: [
				{
					from: `        // Allow unauthenticated access
        const itemsService = new ItemsService(this.collection, {
            knex: this.knex,
            schema: this.schema,
        });
        // We read the IDs of the items based on the query, and then run \`updateMany\`. \`updateMany\` does it's own
        // permissions check for the keys, so we don't have to make this an authenticated read
        const items = await itemsService.readByQuery(readQuery);`,
					to: `        // Validate read permissions for the query so hidden field values cannot leak (GHSA-2xcm-7h22-3m66)
        const items = await this.readByQuery(readQuery);`,
				},
			],
		},
	]);
}

{
	const src = read("9.26.0", "services/items.js");
	writeOverlay("GHSA-2xcm-7h22-3m66", "9.26.0", [
		{
			file: "services/items.js",
			src,
			replace: [
				{
					from: `        // Allow unauthenticated access
        const itemsService = new ItemsService(this.collection, {
            knex: this.knex,
            schema: this.schema,
        });
        // We read the IDs of the items based on the query, and then run \`updateMany\`. \`updateMany\` does it's own
        // permissions check for the keys, so we don't have to make this an authenticated read
        const items = await itemsService.readByQuery(readQuery);`,
					to: `        // Validate read permissions for the query so hidden field values cannot leak (GHSA-2xcm-7h22-3m66)
        const items = await this.readByQuery(readQuery);`,
				},
			],
		},
	]);
}

// --- GHSA-jvxj-w2qp-5vmx GraphQL WS IP (11 only) ---
{
	const gql = read("11.17.4", "websocket/controllers/graphql.js");
	const fga = read("11.17.4", "permissions/modules/fetch-global-access/fetch-global-access.js");
	writeOverlay("GHSA-jvxj-w2qp-5vmx", "11.17.4", [
		{
			file: "websocket/controllers/graphql.js",
			src: gql,
			replace: [
				{
					from: 'const { accountability, expires_at } = await authenticateConnection({ access_token: params.access_token }, { ip: client.accountability?.ip ?? null });',
					to: 'const { accountability, expires_at } = await authenticateConnection({ access_token: params.access_token }, { ip: client.accountability?.ip ?? null, userAgent: client.accountability?.userAgent, origin: client.accountability?.origin });',
				},
				{
					from: "\tasync handleHandshakeUpgrade({ request, socket, head }) {\n\t\tthis.server.handleUpgrade(request, socket, head, async (ws) => {\n\t\t\tthis.server.emit(\"connection\", ws, {\n\t\t\t\taccountability: createDefaultAccountability(),\n\t\t\t\texpires_at: null\n\t\t\t});\n\t\t});\n\t}",
					to: "\tasync handleHandshakeUpgrade({ request, socket, head, accountabilityOverrides }) {\n\t\tthis.server.handleUpgrade(request, socket, head, async (ws) => {\n\t\t\tthis.server.emit(\"connection\", ws, {\n\t\t\t\taccountability: createDefaultAccountability(accountabilityOverrides),\n\t\t\t\texpires_at: null\n\t\t\t});\n\t\t});\n\t}",
				},
			],
		},
		{
			file: "permissions/modules/fetch-global-access/fetch-global-access.js",
			src: fga,
			replace: [
				{
					from: 'const fetchGlobalAccess = withCache("global-access", _fetchGlobalAccess, ({ user, roles }, { ip }) => ({\n\tuser,\n\troles,\n\tip\n}));',
					to: 'const fetchGlobalAccess = withCache("global-access", _fetchGlobalAccess, ({ user, roles, ip }) => ({\n\tuser,\n\troles,\n\tip\n}));',
				},
			],
		},
	]);
}

// --- GHSA-xf86-hfpm-92xr AI chat admin tools (11 only) ---
{
	const src = read("11.17.4", "ai/chat/utils/chat-request-tool-to-ai-sdk-tool.js");
	writeOverlay("GHSA-xf86-hfpm-92xr", "11.17.4", [
		{
			file: "ai/chat/utils/chat-request-tool-to-ai-sdk-tool.js",
			src,
			replace: [
				{
					from: 'import { InvalidPayloadError } from "@directus/errors";',
					to: 'import { ForbiddenError, InvalidPayloadError } from "@directus/errors";',
				},
				{
					from: '\t\tconst directusTool = ALL_TOOLS.find(({ name }) => name === chatRequestTool);\n\t\tif (!directusTool) throw new InvalidPayloadError({ reason: `Tool by name "${chatRequestTool}" does not exist` });',
					to: '\t\tconst directusTool = ALL_TOOLS.find(({ name }) => name === chatRequestTool);\n\t\tif (!directusTool) throw new InvalidPayloadError({ reason: `Tool by name "${chatRequestTool}" does not exist` });\n\t\tif (directusTool.admin && accountability.admin !== true) throw new ForbiddenError({ reason: "You must be an admin to access this tool" });',
				},
			],
		},
	]);
}
