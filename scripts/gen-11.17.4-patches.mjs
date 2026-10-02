import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";


const ORIG = "/tmp/dx11api";
const CATALOG = path.resolve(import.meta.dirname, "../catalog");

function sha(s) {
	return createHash("sha256").update(s).digest("hex");
}

function excerpt(src, start, end) {
	const i = src.indexOf(start);
	if (i < 0) throw new Error("start not found: " + JSON.stringify(start.slice(0, 120)));
	const j = src.indexOf(end, i);
	if (j < 0) throw new Error("end not found after " + JSON.stringify(start.slice(0, 80)));
	const out = src.slice(i, j + end.length);
	const n = src.split(out).length - 1;
	if (n !== 1) throw new Error("excerpt matched " + n + " times: " + JSON.stringify(start.slice(0, 80)));
	return out;
}

function apply(src, replace) {
	let next = src;
	for (const { from, to } of replace) {
		const n = next.split(from).length - 1;
		if (n !== 1) throw new Error("from matched " + n + " times:\n" + from.slice(0, 160));
		next = next.split(from).join(to);
	}
	if (next === src) throw new Error("no changes");
	return next;
}

function writeTargets(id, entries) {
	const dir = path.join(CATALOG, "patches", id);
	fs.mkdirSync(dir, { recursive: true });
	const doc = entries.map(({ file, src, replace }) => {
		const after = apply(src, replace);
		return {
			file,
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
	fs.writeFileSync(path.join(dir, "targets.yml"), yaml);
	console.log(id, "ok", doc.length, "file(s)");
}

const ws = fs.readFileSync(path.join(ORIG, "ws-base.js"), "utf8");
const deep = fs.readFileSync(path.join(ORIG, "sanitize-query.js"), "utf8");
const geo = fs.readFileSync(path.join(ORIG, "types.js"), "utf8");
const pg = fs.readFileSync(path.join(ORIG, "postgres.js"), "utf8");
const tus = fs.readFileSync(path.join(ORIG, "tus-data-store.js"), "utf8");
const ip = fs.readFileSync(path.join(ORIG, "is-denied-ip.js"), "utf8");
const cache = fs.readFileSync(path.join(ORIG, "get-cache-key.js"), "utf8");
const shares = fs.readFileSync(path.join(ORIG, "shares.js"), "utf8");
const users = fs.readFileSync(path.join(ORIG, "users.js"), "utf8");
const gqlws = fs.readFileSync(path.join(ORIG, "graphql.js"), "utf8");
const mail = fs.readFileSync(path.join(ORIG, "mail.js"), "utf8");
const settings = fs.readFileSync(path.join(ORIG, "settings.js"), "utf8");
const gql = fs.readFileSync(path.join(ORIG, "gql-service.js"), "utf8");
const ai = fs.readFileSync(path.join(ORIG, "create-ui-stream.js"), "utf8");
const files = fs.readFileSync(path.join(ORIG, "files.js"), "utf8");

{
	const from1 = excerpt(
		ws,
		"\t\t} catch (error) {\n\t\t\tlogger.trace(`WebSocket#${client.uid} failed authentication`);\n\t\t\temitter_default.emitAction(\"websocket.auth.failure\", { client });\n\t\t\tclient.accountability = null;\n\t\t\tclient.expires_at = null;",
		"client.expires_at = null;",
	);
	const from2 = excerpt(
		ws,
		"\t\tclient.auth_timer = setTimeout(() => {\n\t\t\tclient.accountability = null;\n\t\t\tclient.expires_at = null;\n\t\t\thandleWebSocketError(client, new TokenExpiredError(), \"auth\");",
		"handleWebSocketError(client, new TokenExpiredError(), \"auth\");",
	);
	writeTargets("GHSA-97xr-jchp-xm3c", [
		{
			file: "@directus/api/dist/websocket/controllers/base.js",
			src: ws,
			replace: [
				{
					from: from1,
					to: from1.replace(
						"client.accountability = null;",
						"client.accountability = createDefaultAccountability(accountabilityOverrides);",
					),
				},
				{
					from: from2,
					to: from2.replace(
						"client.accountability = null;\n\t\t\tclient.expires_at = null;",
						"client.accountability = createDefaultAccountability({\n\t\t\t\tip: client.accountability?.ip ?? null,\n\t\t\t\tuserAgent: client.accountability?.userAgent,\n\t\t\t\torigin: client.accountability?.origin\n\t\t\t});\n\t\t\tclient.expires_at = null;",
					),
				},
			],
		},
	]);
}

{
	const from1 = excerpt(deep, "\tconst result = {};\n\tif (typeof deep === \"string\") try {", "try {");
	const from2 = excerpt(deep, "\t\tconst subQuery = {};\n\t\tconst parsedLevel = {};", "parsedLevel = {};");
	const from3 = excerpt(
		deep,
		"if (Object.keys(parsedLevel).length > 0) set(result, path, merge({}, get(result, path, {}), parsedLevel));",
		"parsedLevel));",
	);
	writeTargets("GHSA-gwvv-rr68-cmv6", [
		{
			file: "@directus/api/dist/utils/sanitize-query.js",
			src: deep,
			replace: [
				{ from: from1, to: from1.replace("const result = {};", "const result = Object.create(null);") },
				{
					from: from2,
					to: from2
						.replace("const subQuery = {};", "const subQuery = Object.create(null);")
						.replace("const parsedLevel = {};", "const parsedLevel = Object.create(null);"),
				},
				{
					from: from3,
					to: "if (Object.keys(parsedLevel).length > 0) set(result, path, merge(Object.create(null), get(result, path, Object.create(null)), parsedLevel));",
				},
			],
		},
	]);
}

{
	const from = excerpt(
		ws,
		"\t\tif (this.clients.size >= this.maxConnections) {",
		"\t\tconst env = useEnv();",
	);
	const originBlock = [
		"\t\tconst originHeader = request.headers[\"origin\"];",
		"\t\tif (originHeader) {",
		"\t\t\tlet originUrl;",
		"\t\t\ttry {",
		"\t\t\t\toriginUrl = new URL(originHeader);",
		"\t\t\t} catch {",
		"\t\t\t\tlogger.debug(`WebSocket upgrade denied - disallowed Origin: ${originHeader}`);",
		"\t\t\t\tsocket.write(\"HTTP/1.1 403 Forbidden\\r\\n\\r\\n\");",
		"\t\t\t\tsocket.destroy();",
		"\t\t\t\treturn;",
		"\t\t\t}",
		"\t\t\tconst envOrigin = useEnv();",
		"\t\t\tconst host = request.headers[\"host\"];",
		"\t\t\tconst publicUrl = envOrigin[\"PUBLIC_URL\"];",
		"\t\t\tconst sameHost = Boolean(host) && originUrl.host === host;",
		"\t\t\tconst samePublic = typeof publicUrl === \"string\" && URL.canParse(publicUrl) && new URL(publicUrl).origin === originUrl.origin;",
		"\t\t\tlet corsMatch = false;",
		"\t\t\tif (envOrigin[\"CORS_ENABLED\"] === true) {",
		"\t\t\t\tconst corsOrigin = envOrigin[\"CORS_ORIGIN\"];",
		"\t\t\t\tif (corsOrigin === true) corsMatch = true;",
		"\t\t\t\telse if (typeof corsOrigin === \"string\" && corsOrigin !== \"*\") corsMatch = corsOrigin === originHeader;",
		"\t\t\t\telse if (Array.isArray(corsOrigin)) corsMatch = corsOrigin.includes(originHeader);",
		"\t\t\t}",
		"\t\t\tif (!sameHost && !samePublic && !corsMatch) {",
		"\t\t\t\tlogger.debug(`WebSocket upgrade denied - disallowed Origin: ${originHeader}`);",
		"\t\t\t\tsocket.write(\"HTTP/1.1 403 Forbidden\\r\\n\\r\\n\");",
		"\t\t\t\tsocket.destroy();",
		"\t\t\t\treturn;",
		"\t\t\t}",
		"\t\t}",
		"\t\tconst env = useEnv();",
	].join("\n");
	writeTargets("GHSA-mww8-4gwh-rjfw", [
		{
			file: "@directus/api/dist/websocket/controllers/base.js",
			src: ws,
			replace: [{ from, to: from.replace("\t\tconst env = useEnv();", originBlock) }],
		},
	]);
}

{
	const geoAllow = [
		"\t\tconst rawType = field.type.split(\".\")[1] ?? \"geometry\";",
		"\t\tconst allowedGeo = [\"geometry\", \"Point\", \"LineString\", \"Polygon\", \"MultiPoint\", \"MultiLineString\", \"MultiPolygon\", \"GeometryCollection\"];",
		"\t\tconst type = allowedGeo.find((value) => value.toLowerCase() === String(rawType).toLowerCase()) ?? \"geometry\";",
	].join("\n");
	const fromGeo = excerpt(
		geo,
		"\tcreateColumn(table, field) {\n\t\tconst type = field.type.split(\".\")[1] ?? \"geometry\";\n\t\treturn table.specificType(field.field, type);\n\t}",
		"field.field, type);\n\t}",
	);
	const fromPg = excerpt(
		pg,
		"\tcreateColumn(table, field) {\n\t\tconst type = field.type.split(\".\")[1] ?? \"geometry\";\n\t\treturn table.specificType(field.field, `geometry(${type}, 4326)`);\n\t}",
		"4326)`);\n\t}",
	);
	writeTargets("GHSA-chfm-g7r3-vv42", [
		{
			file: "@directus/api/dist/database/helpers/geometry/types.js",
			src: geo,
			replace: [
				{
					from: fromGeo,
					to: fromGeo.replace("\t\tconst type = field.type.split(\".\")[1] ?? \"geometry\";", geoAllow),
				},
			],
		},
		{
			file: "@directus/api/dist/database/helpers/geometry/dialects/postgres.js",
			src: pg,
			replace: [
				{
					from: fromPg,
					to: fromPg.replace("\t\tconst type = field.type.split(\".\")[1] ?? \"geometry\";", geoAllow),
				},
			],
		},
	]);
}

{
	const from = excerpt(
		tus,
		"\t\tconst fileData = {\n\t\t\t...omit(upload.metadata, [\"id\", \"replace_id\"]),",
		"if (\"folder\" in fileData === false) {",
	);
	const inject = [
		"\t\tif (fileData.filename_disk) {",
		"\t\t\tconst disk = String(fileData.filename_disk).replaceAll(\"\\\\\", \"/\");",
		"\t\t\tif (disk.includes(\"..\") || disk.startsWith(\"/\") || disk.includes(\"\\0\")) throw ERRORS.INVALID_METADATA;",
		"\t\t\tfileData.filename_disk = disk.split(\"/\").filter(Boolean).join(\"/\");",
		"\t\t}",
		"\t\tif (\"folder\" in fileData === false) {",
	].join("\n");
	writeTargets("GHSA-3742-46gx-c8cc", [
		{
			file: "@directus/api/dist/services/tus/data-store.js",
			src: tus,
			replace: [{ from, to: from.replace("\t\tif (\"folder\" in fileData === false) {", inject) }],
		},
	]);
}

{
	const from = excerpt(
		tus,
		"\t\tconst primaryKey = await filesItemsService.createOne(fileData, { emitEvents: false });\n\t\tif (!upload.metadata[\"id\"]) upload.metadata[\"id\"] = primaryKey;",
		"primaryKey;",
	);
	writeTargets("GHSA-xjxq-pj7h-g676", [
		{
			file: "@directus/api/dist/services/tus/data-store.js",
			src: tus,
			replace: [
				{
					from,
					to: "\t\tif (existingFile && upload.metadata[\"id\"]) await filesItemsService.readOne(upload.metadata[\"id\"]);\n\t\tconst primaryKey = await filesItemsService.createOne(fileData, { emitEvents: false });\n\t\tif (!existingFile) upload.metadata[\"id\"] = primaryKey;",
				},
			],
		},
	]);
}

{
	const fromImp = excerpt(
		ai,
		"import { ServiceUnavailableError } from \"@directus/errors\";\nimport { convertToModelMessages, stepCountIs, streamText, wrapLanguageModel } from \"ai\";",
		"from \"ai\";",
	);
	const fromStream = excerpt(ai, "\treturn streamText({\n\t\tsystem: baseSystemPrompt,\n\t\tmodel: languageModel,", "model: languageModel,");
	const downloadFn = [
		"\treturn streamText({",
		"\t\texperimental_download: async (requestedDownloads) => {",
		"\t\t\tconst axios = await getAxios();",
		"\t\t\treturn Promise.all(requestedDownloads.map(async ({ url, isUrlSupportedByModel }) => {",
		"\t\t\t\tif (isUrlSupportedByModel) return null;",
		"\t\t\t\tif (url.protocol !== \"http:\" && url.protocol !== \"https:\") throw new Error(`Unsupported URL protocol for asset download: \"${url.protocol}\"`);",
		"\t\t\t\tconst response = await axios.get(url.toString(), { responseType: \"arraybuffer\" });",
		"\t\t\t\tconst contentType = response.headers[\"content-type\"];",
		"\t\t\t\tconst mediaType = typeof contentType === \"string\" ? contentType.split(\";\")[0]?.trim() : void 0;",
		"\t\t\t\treturn {",
		"\t\t\t\t\tdata: new Uint8Array(response.data),",
		"\t\t\t\t\tmediaType",
		"\t\t\t\t};",
		"\t\t\t}));",
		"\t\t},",
		"\t\tsystem: baseSystemPrompt,",
		"\t\tmodel: languageModel,",
	].join("\n");
	writeTargets("GHSA-4jw7-6mqj-vrhq", [
		{
			file: "@directus/api/dist/ai/chat/lib/create-ui-stream.js",
			src: ai,
			replace: [
				{
					from: fromImp,
					to: "import { getAxios } from \"../../../request/index.js\";\n" + fromImp,
				},
				{ from: fromStream, to: downloadFn },
			],
		},
	]);
}

{
	const fromImp = excerpt(
		gql,
		"import { NoSchemaIntrospectionCustomRule, execute, specifiedRules, validate } from \"graphql\";",
		"from \"graphql\";",
	);
	const fromRules = excerpt(
		gql,
		"const validationRules = Array.from(specifiedRules);\nif (env[\"GRAPHQL_INTROSPECTION\"] === false) validationRules.push(NoSchemaIntrospectionCustomRule);",
		"NoSchemaIntrospectionCustomRule);",
	);
	const extra = [
		fromRules,
		"const sensitiveMutations = new Set([\"users_register\", \"users_invite\", \"users_register_verify_email\", \"auth_login\", \"auth_password_request\", \"auth_password_reset\", \"users_me_tfa_enable\", \"users_me_tfa_disable\", \"users_me_tfa_generate\"]);",
		"validationRules.push((context) => {",
		"\tconst counts = /* @__PURE__ */ new Map();",
		"\treturn {",
		"\t\tField(node) {",
		"\t\t\tif (context.getOperation()?.operation !== \"mutation\") return;",
		"\t\t\tconst name = node.name.value;",
		"\t\t\tif (!sensitiveMutations.has(name) && !name.includes(\"users_register\") && !name.includes(\"password\") && !name.includes(\"invite\") && !name.includes(\"tfa\")) return;",
		"\t\t\tconst n = (counts.get(name) ?? 0) + 1;",
		"\t\t\tcounts.set(name, n);",
		"\t\t\tif (n > 1) context.reportError(new GraphQLError(`\"${name}\" can only be used once per request`));",
		"\t\t}",
		"\t};",
		"});",
	].join("\n");
	writeTargets("GHSA-g293-vf99-xv36", [
		{
			file: "@directus/api/dist/services/graphql/index.js",
			src: gql,
			replace: [
				{
					from: fromImp,
					to: "import { GraphQLError, NoSchemaIntrospectionCustomRule, execute, specifiedRules, validate } from \"graphql\";",
				},
				{ from: fromRules, to: extra },
			],
		},
	]);
}

{
	const from = excerpt(
		ip,
		"\t\t\tif (blockNetwork === \"0.0.0.0\") {\n\t\t\t\tblockNetworkInterfaces = true;\n\t\t\t\tcontinue;\n\t\t\t}",
		"continue;\n\t\t\t}",
	);
	writeTargets("GHSA-j5h6-vqc3-phqh", [
		{
			file: "@directus/api/dist/request/is-denied-ip.js",
			src: ip,
			replace: [
				{
					from,
					to: from.replace(
						"blockNetworkInterfaces = true;\n\t\t\t\tcontinue;",
						"blockNetworkInterfaces = true;\n\t\t\t\tblockList.parseSubnet(\"0.0.0.0/8\");\n\t\t\t\tblockList.parseAddress(\"::\");\n\t\t\t\tcontinue;",
					),
				},
			],
		},
	]);
}

{
	const from = excerpt(cache, "\treturn hash({\n\t\tversion,\n\t\tuser: req.accountability?.user || null,", "accountability.ip }\n\t});");
	writeTargets("GHSA-c6w9-5g5j-jh2p", [
		{
			file: "@directus/api/dist/utils/get-cache-key.js",
			src: cache,
			replace: [
				{
					from,
					to: from
						.replace(
							"user: req.accountability?.user || null,\n\t\tpath,",
							"user: req.accountability?.user || null,\n\t\trole: req.accountability?.role || null,\n\t\tadmin: req.accountability?.admin || false,\n\t\tapp: req.accountability?.app || false,\n\t\tpath,",
						)
						.replace(
							"...includeIp && { ip: req.accountability.ip }",
							"...req.accountability?.share && { share: req.accountability.share },\n\t\t...includeIp && { ip: req.accountability.ip }",
						),
				},
			],
		},
	]);
}

{
	const fromImp = excerpt(
		shares,
		"import { ForbiddenError, InvalidCredentialsError } from \"@directus/errors\";",
		"from \"@directus/errors\";",
	);
	const fromUpd = excerpt(
		shares,
		"\tasync updateMany(keys, data, opts) {\n\t\tawait clearCache();\n\t\treturn super.updateMany(keys, data, opts);\n\t}",
		"super.updateMany(keys, data, opts);\n\t}",
	);
	writeTargets("GHSA-7h45-q5jx-7r87", [
		{
			file: "@directus/api/dist/services/shares.js",
			src: shares,
			replace: [
				{
					from: fromImp,
					to: "import { ForbiddenError, InvalidCredentialsError, InvalidPayloadError } from \"@directus/errors\";",
				},
				{
					from: fromUpd,
					to: "\tasync updateMany(keys, data, opts) {\n\t\tif (\"user_created\" in data) throw new InvalidPayloadError({ reason: `You can't change the \"user_created\" value manually` });\n\t\tif (\"role\" in data && this.accountability && this.accountability.admin !== true) throw new ForbiddenError();\n\t\tawait clearCache();\n\t\treturn super.updateMany(keys, data, opts);\n\t}",
				},
			],
		},
	]);
}

{
	const fromPayload = excerpt(
		users,
		"\t\t\tconst mailService = new MailService(serviceOptions);\n\t\t\tconst payload = {\n\t\t\t\temail: input.email,\n\t\t\t\tscope: \"pending-registration\"\n\t\t\t};",
		"pending-registration\"\n\t\t\t};",
	);
	const fromSend = excerpt(
		users,
		"\t\t\tmailService.send({\n\t\t\t\tto: input.email,\n\t\t\t\tsubject: \"Verify your email address\",\n\t\t\t\ttemplate: {\n\t\t\t\t\tname: \"user-registration\",\n\t\t\t\t\tdata: {\n\t\t\t\t\t\turl: verificationUrl,\n\t\t\t\t\t\temail: input.email,",
		"email: input.email,",
	);
	writeTargets("GHSA-8xp8-xrh2-88vr", [
		{
			file: "@directus/api/dist/services/users.js",
			src: users,
			replace: [
				{
					from: fromPayload,
					to: fromPayload.replace(
						"const payload = {\n\t\t\t\temail: input.email,",
						"const verificationEmail = user?.email ?? input.email;\n\t\t\tconst payload = {\n\t\t\t\temail: verificationEmail,",
					),
				},
				{
					from: fromSend,
					to: fromSend.replaceAll("input.email", "verificationEmail"),
				},
			],
		},
	]);
}

{
	const fromImp = excerpt(
		settings,
		"import { ItemsService } from \"./items.js\";\nimport { sendReport } from \"../telemetry/lib/send-report.js\";",
		"send-report.js\";",
	);
	const fromEnd = excerpt(settings, "\t\t\tproject_status: null\n\t\t});\n\t}\n};", "\t}\n};");
	const extra = [
		"\t\t\tproject_status: null",
		"\t\t});",
		"\t}",
		"\tassertSafeProjectColor(data) {",
		"\t\tif (!data || !(\"project_color\" in data) || data.project_color == null) return;",
		"\t\tif (!/^#[0-9A-Fa-f]{3,8}$/.test(String(data.project_color))) throw new InvalidPayloadError({ reason: `\"project_color\" must be a hex color` });",
		"\t}",
		"\tasync createOne(data, opts) {",
		"\t\tthis.assertSafeProjectColor(data);",
		"\t\treturn super.createOne(data, opts);",
		"\t}",
		"\tasync updateMany(keys, data, opts) {",
		"\t\tthis.assertSafeProjectColor(data);",
		"\t\treturn super.updateMany(keys, data, opts);",
		"\t}",
		"\tasync upsertSingleton(data, opts) {",
		"\t\tthis.assertSafeProjectColor(data);",
		"\t\treturn super.upsertSingleton(data, opts);",
		"\t}",
		"};",
	].join("\n");
	writeTargets("GHSA-788p-cvgf-q973", [
		{
			file: "@directus/api/dist/services/settings.js",
			src: settings,
			replace: [
				{
					from: fromImp,
					to: "import { ItemsService } from \"./items.js\";\nimport { InvalidPayloadError } from \"@directus/errors\";\nimport { sendReport } from \"../telemetry/lib/send-report.js\";",
				},
				{ from: fromEnd, to: extra },
			],
		},
	]);
}

{
	const fromCreate = excerpt(
		files,
		"\tasync createOne(data, opts = {}) {\n\t\tif (!data.type) throw new InvalidPayloadError({ reason: `\"type\" is required` });",
		"is required` });",
	);
	const fromUpdate = excerpt(
		files,
		"\tasync updateMany(keys, data, opts = {}) {\n\t\tif (keys.length === 1 && data.filename_disk) {",
		"data.filename_disk) {",
	);
	const accessCreate = [
		"\tasync createOne(data, opts = {}) {",
		"\t\tif (this.accountability) await validateAccess({",
		"\t\t\taccountability: this.accountability,",
		"\t\t\taction: \"create\",",
		"\t\t\tcollection: \"directus_files\"",
		"\t\t}, {",
		"\t\t\tknex: this.knex,",
		"\t\t\tschema: this.schema",
		"\t\t});",
		"\t\tif (!data.type) throw new InvalidPayloadError({ reason: `\"type\" is required` });",
	].join("\n");
	const accessUpdate = [
		"\tasync updateMany(keys, data, opts = {}) {",
		"\t\tif (this.accountability) await validateAccess({",
		"\t\t\taccountability: this.accountability,",
		"\t\t\taction: \"update\",",
		"\t\t\tcollection: \"directus_files\",",
		"\t\t\tprimaryKeys: keys",
		"\t\t}, {",
		"\t\t\tknex: this.knex,",
		"\t\t\tschema: this.schema",
		"\t\t});",
		"\t\tif (keys.length === 1 && data.filename_disk) {",
	].join("\n");
	writeTargets("GHSA-p623-wgx3-wxp8", [
		{
			file: "@directus/api/dist/services/files.js",
			src: files,
			replace: [
				{ from: fromCreate, to: accessCreate },
				{ from: fromUpdate, to: accessUpdate },
			],
		},
	]);
}

{
	const from = excerpt(
		settings,
		"\tconstructor(options) {\n\t\tsuper(\"directus_settings\", options);\n\t}\n\tasync setOwner(data) {",
		"async setOwner(data) {",
	);
	const insert = [
		"\tconstructor(options) {",
		"\t\tsuper(\"directus_settings\", options);",
		"\t}",
		"\tasync readByQuery(query, opts) {",
		"\t\tconst data = await super.readByQuery(query, opts);",
		"\t\tif (this.accountability?.admin === true || this.accountability === null) return data;",
		"\t\tconst sensitive = [\"ai_openai_api_key\", \"ai_anthropic_api_key\", \"ai_google_api_key\", \"ai_openai_compatible_api_key\"];",
		"\t\tfor (const record of data ?? []) {",
		"\t\t\tif (!record) continue;",
		"\t\t\tfor (const field of sensitive) if (field in record) record[field] = null;",
		"\t\t}",
		"\t\treturn data;",
		"\t}",
		"\tasync setOwner(data) {",
	].join("\n");
	writeTargets("GHSA-r9xq-xp38-j4j3", [
		{
			file: "@directus/api/dist/services/settings.js",
			src: settings,
			replace: [{ from, to: insert }],
		},
	]);
}

{
	const from = excerpt(settings, "\tasync setOwner(data) {", "\t\t});\n\t}");
	const to = [
		"\tasync setOwner(data) {",
		"\t\tconst { project_id } = await this.knex.select(\"project_id\").from(\"directus_settings\").first();",
		"\t\tconst primaryKey = await this.upsertSingleton({",
		"\t\t\tproject_owner: data.project_owner,",
		"\t\t\tproject_usage: data.project_usage,",
		"\t\t\torg_name: data.org_name,",
		"\t\t\tproduct_updates: data.product_updates,",
		"\t\t\tproject_status: null",
		"\t\t});",
		"\t\tsendReport({",
		"\t\t\t...data,",
		"\t\t\tproject_id,",
		"\t\t\tversion",
		"\t\t}).catch(async () => {",
		"\t\t\tawait this.knex.update(\"project_status\", \"pending\").from(\"directus_settings\");",
		"\t\t});",
		"\t\treturn primaryKey;",
		"\t}",
	].join("\n");
	writeTargets("GHSA-6hpw-rhhq-6xq3", [
		{
			file: "@directus/api/dist/services/settings.js",
			src: settings,
			replace: [{ from, to }],
		},
	]);
}

{
	const fromImp = excerpt(gqlws, "import { CloseCode, MessageType, makeServer } from \"graphql-ws\";", "from \"graphql-ws\";");
	const fromServer = excerpt(gqlws, "\t\tthis.gql = makeServer({ schema: async (ctx) => {", "}).getSchema();\n\t\t} });");
	const toServer = [
		"\t\tthis.gql = makeServer({",
		"\t\t\tschema: async (ctx) => {",
		"\t\t\t\tconst accountability = ctx.extra.client.accountability;",
		"\t\t\t\treturn new GraphQLService({",
		"\t\t\t\t\tschema: await getSchema(),",
		"\t\t\t\t\tscope: \"items\",",
		"\t\t\t\t\taccountability",
		"\t\t\t\t}).getSchema();",
		"\t\t\t},",
		"\t\t\tasync onSubscribe(_ctx, _id, payload) {",
		"\t\t\t\tconst env = useEnv();",
		"\t\t\t\ttry {",
		"\t\t\t\t\tparse(payload.query, { maxTokens: Number(env[\"GRAPHQL_QUERY_TOKEN_LIMIT\"]) });",
		"\t\t\t\t} catch {",
		"\t\t\t\t\treturn [new GraphQLError(\"Failed to parse GraphQL document.\")];",
		"\t\t\t\t}",
		"\t\t\t}",
		"\t\t});",
	].join("\n");
	writeTargets("GHSA-ff8w-8crv-9rcf", [
		{
			file: "@directus/api/dist/websocket/controllers/graphql.js",
			src: gqlws,
			replace: [
				{
					from: fromImp,
					to: fromImp + "\nimport { GraphQLError, parse } from \"graphql\";\nimport { useEnv } from \"@directus/env\";",
				},
				{ from: fromServer, to: toServer },
			],
		},
	]);
}

{
	const from = excerpt(
		mail,
		"\tasync renderTemplate(template, variables) {\n\t\tconst customTemplatePath = path.resolve(env[\"EMAIL_TEMPLATES_PATH\"], template + \".liquid\");",
		"doesn't exist` });",
	);
	const to = [
		"\tasync renderTemplate(template, variables) {",
		"\t\tconst customTemplatesDir = path.resolve(env[\"EMAIL_TEMPLATES_PATH\"]);",
		"\t\tconst systemTemplatesDir = path.join(__dirname, \"templates\");",
		"\t\tconst customTemplatePath = path.resolve(customTemplatesDir, template + \".liquid\");",
		"\t\tconst systemTemplatePath = path.resolve(systemTemplatesDir, template + \".liquid\");",
		"\t\tconst isWithin = (dir, candidate) => candidate === dir || candidate.startsWith(dir + path.sep);",
		"\t\tlet templatePath = null;",
		"\t\tif (isWithin(customTemplatesDir, customTemplatePath) && await fse.pathExists(customTemplatePath)) templatePath = customTemplatePath;",
		"\t\telse if (isWithin(systemTemplatesDir, systemTemplatePath) && await fse.pathExists(systemTemplatePath)) templatePath = systemTemplatePath;",
		"\t\tif (templatePath === null) throw new InvalidPayloadError({ reason: `Template \"${template}\" doesn't exist` });",
	].join("\n");
	writeTargets("GHSA-5h38-6755-g83w", [
		{
			file: "@directus/api/dist/services/mail/index.js",
			src: mail,
			replace: [{ from, to }],
		},
	]);
}

const notes = {
	"GHSA-97xr-jchp-xm3c":
		"Pinned to Directus 11.17.4. Failed or expired WebSocket auth now resets to public accountability instead of null (null is treated as system). Restart required.",
	"GHSA-gwvv-rr68-cmv6":
		"Pinned to Directus 11.17.4. sanitizeDeep builds Object.create(null) so prototype pollution in `deep` cannot persist. Restart required.",
	"GHSA-mww8-4gwh-rjfw":
		"Pinned to Directus 11.17.4. WebSocket upgrades require Origin to match Host, PUBLIC_URL, or CORS_ORIGIN. Restart required.",
	"GHSA-chfm-g7r3-vv42":
		"Pinned to Directus 11.17.4. Geometry column types are allowlisted before interpolation into PostGIS DDL. Restart required.",
	"GHSA-3742-46gx-c8cc":
		"Pinned to Directus 11.17.4. TUS filename_disk rejects `..` and absolute paths. Restart required.",
	"GHSA-xjxq-pj7h-g676":
		"Pinned to Directus 11.17.4. TUS replacements must be readable with the uploader's accountability; attacker-supplied ids no longer stick. Restart required.",
	"GHSA-4jw7-6mqj-vrhq":
		"Pinned to Directus 11.17.4. AI chat file downloads go through getAxios (IMPORT_IP_DENY_LIST). Restart required.",
	"GHSA-g293-vf99-xv36":
		"Pinned to Directus 11.17.4. System GraphQL mutations for register/password/invite/TFA cannot be alias-amplified. Restart required.",
	"GHSA-j5h6-vqc3-phqh":
		"Pinned to Directus 11.17.4. IMPORT_IP_DENY_LIST=0.0.0.0 also blocks 0.0.0.0/8 and IPv6 unspecified. Restart required.",
	"GHSA-c6w9-5g5j-jh2p":
		"Pinned to Directus 11.17.4. Cache keys include role/admin/app/share so authorization-dependent responses are not reused. Restart required.",
	"GHSA-7h45-q5jx-7r87":
		"Pinned to Directus 11.17.4. Share updates cannot reassign user_created; non-admins cannot set role. Restart required.",
	"GHSA-8xp8-xrh2-88vr":
		"Pinned to Directus 11.17.4. Public registration verification mail goes to the stored account email, not the submitted address. Restart required.",
	"GHSA-788p-cvgf-q973":
		"Pinned to Directus 11.17.4. project_color writes must be hex so the Studio favicon cannot interpolate markup. Restart required.",
	"GHSA-p623-wgx3-wxp8":
		"Pinned to Directus 11.17.4. Files create/update validateAccess before filename/storage side effects. Restart required.",
	"GHSA-r9xq-xp38-j4j3":
		"Pinned to Directus 11.17.4. Non-admin reads of directus_settings null out AI API keys. Restart required.",
	"GHSA-6hpw-rhhq-6xq3":
		"Pinned to Directus 11.17.4. Project-owner telemetry runs only after upsertSingleton (permission check). Restart required.",
	"GHSA-ff8w-8crv-9rcf":
		"Pinned to Directus 11.17.4. GraphQL WebSocket subscribe payloads are parsed with GRAPHQL_QUERY_TOKEN_LIMIT. Restart required.",
	"GHSA-5h38-6755-g83w":
		"Pinned to Directus 11.17.4. Mail templates must resolve inside the configured templates directories. Restart required.",
};

const advPath = path.join(CATALOG, "advisories.yml");
let yml = fs.readFileSync(advPath, "utf8");
for (const [id, note] of Object.entries(notes)) {
	const re = new RegExp(
		`(  - id: ${id}\\n(?:.*\\n)*?    port:\\n)      status: needs-port\\n      risk: (\\w+)\\n      notes: .*`,
	);
	if (!re.test(yml)) {
		console.warn("could not update advisory", id);
		continue;
	}
	yml = yml.replace(re, `$1      status: experimental\n      risk: $2\n      notes: ${JSON.stringify(note)}`);
}
fs.writeFileSync(advPath, yml);
console.log("advisories.yml updated");
