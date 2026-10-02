import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIST = "/tmp/directus-9.26.0-api/dist";
const CATALOG = path.resolve(import.meta.dirname, "../catalog");

function sha(s) {
	return createHash("sha256").update(s).digest("hex");
}

function read(rel) {
	return fs.readFileSync(path.join(DIST, rel), "utf8");
}

function apply(src, replace) {
	let next = src;
	for (const { from, to } of replace) {
		const n = next.split(from).length - 1;
		if (n !== 1) throw new Error(`from matched ${n} times:\n${from.slice(0, 200)}`);
		next = next.split(from).join(to);
	}
	if (next === src) throw new Error("no changes");
	return next;
}

function writeOverlay(id, entries) {
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
	fs.writeFileSync(path.join(dir, "9.26.0.yml"), yaml);
	console.log(id, "ok", doc.length, "file(s)");
}

writeOverlay("GHSA-c6w9-5g5j-jh2p", [
	{
		file: "utils/get-cache-key.js",
		src: read("utils/get-cache-key.js"),
		replace: [
			{
				from: "    const info = {\n        version,\n        user: req.accountability?.user || null,\n        path,\n        query: isGraphQl ? getGraphqlQueryAndVariables(req) : req.sanitizedQuery,\n    };",
				to: "    const info = {\n        version,\n        user: req.accountability?.user || null,\n        role: req.accountability?.role || null,\n        admin: req.accountability?.admin || false,\n        app: req.accountability?.app || false,\n        path,\n        query: isGraphQl ? getGraphqlQueryAndVariables(req) : req.sanitizedQuery,\n        ...req.accountability?.share && { share: req.accountability.share },\n    };",
			},
		],
	},
]);

writeOverlay("GHSA-chfm-g7r3-vv42", [
	{
		file: "database/helpers/geometry/types.js",
		src: read("database/helpers/geometry/types.js"),
		replace: [
			{
				from: "    createColumn(table, field) {\n        const type = field.type.split('.')[1] ?? 'geometry';\n        return table.specificType(field.field, type);\n    }",
				to: "    createColumn(table, field) {\n        const rawType = field.type.split('.')[1] ?? 'geometry';\n        const allowedGeo = ['geometry', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];\n        const type = allowedGeo.find((value) => value.toLowerCase() === String(rawType).toLowerCase()) ?? 'geometry';\n        return table.specificType(field.field, type);\n    }",
			},
		],
	},
	{
		file: "database/helpers/geometry/dialects/postgres.js",
		src: read("database/helpers/geometry/dialects/postgres.js"),
		replace: [
			{
				from: "    createColumn(table, field) {\n        const type = field.type.split('.')[1] ?? 'geometry';\n        return table.specificType(field.field, `geometry(${type}, 4326)`);\n    }",
				to: "    createColumn(table, field) {\n        const rawType = field.type.split('.')[1] ?? 'geometry';\n        const allowedGeo = ['geometry', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];\n        const type = allowedGeo.find((value) => value.toLowerCase() === String(rawType).toLowerCase()) ?? 'geometry';\n        return table.specificType(field.field, `geometry(${type}, 4326)`);\n    }",
			},
		],
	},
]);

writeOverlay("GHSA-g293-vf99-xv36", [
	{
		file: "services/graphql/index.js",
		src: read("services/graphql/index.js"),
		replace: [
			{
				from: "const validationRules = Array.from(specifiedRules);\nif (env['GRAPHQL_INTROSPECTION'] === false) {\n    validationRules.push(NoSchemaIntrospectionCustomRule);\n}",
				to: "const validationRules = Array.from(specifiedRules);\nif (env['GRAPHQL_INTROSPECTION'] === false) {\n    validationRules.push(NoSchemaIntrospectionCustomRule);\n}\nconst sensitiveMutations = new Set(['users_register', 'users_invite', 'auth_login', 'auth_password_request', 'auth_password_reset', 'users_me_tfa_enable', 'users_me_tfa_disable', 'users_me_tfa_generate']);\nvalidationRules.push((context) => {\n    const counts = new Map();\n    return {\n        Field(node) {\n            if (context.getOperation()?.operation !== 'mutation')\n                return;\n            const name = node.name.value;\n            if (!sensitiveMutations.has(name) && !name.includes('users_register') && !name.includes('password') && !name.includes('invite') && !name.includes('tfa'))\n                return;\n            const n = (counts.get(name) ?? 0) + 1;\n            counts.set(name, n);\n            if (n > 1)\n                context.reportError(new GraphQLError(`\"${name}\" can only be used once per request`));\n        },\n    };\n});",
			},
		],
	},
]);

writeOverlay("GHSA-788p-cvgf-q973", [
	{
		file: "services/settings.js",
		src: read("services/settings.js"),
		replace: [
			{
				from: "import { ItemsService } from './items.js';\nexport class SettingsService extends ItemsService {\n    constructor(options) {\n        super('directus_settings', options);\n    }\n}",
				to: "import { InvalidPayloadException } from '../exceptions/index.js';\nimport { ItemsService } from './items.js';\nexport class SettingsService extends ItemsService {\n    constructor(options) {\n        super('directus_settings', options);\n    }\n    assertSafeProjectColor(data) {\n        if (!data || !('project_color' in data) || data.project_color == null)\n            return;\n        if (!/^#[0-9A-Fa-f]{3,8}$/.test(String(data.project_color)))\n            throw new InvalidPayloadException(`\"project_color\" must be a hex color`);\n    }\n    async createOne(data, opts) {\n        this.assertSafeProjectColor(data);\n        return super.createOne(data, opts);\n    }\n    async updateMany(keys, data, opts) {\n        this.assertSafeProjectColor(data);\n        return super.updateMany(keys, data, opts);\n    }\n    async upsertSingleton(data, opts) {\n        this.assertSafeProjectColor(data);\n        return super.upsertSingleton(data, opts);\n    }\n}",
			},
		],
	},
]);

writeOverlay("GHSA-gwvv-rr68-cmv6", [
	{
		file: "utils/sanitize-query.js",
		src: read("utils/sanitize-query.js"),
		replace: [
			{
				from: "function sanitizeDeep(deep, accountability) {\n    const result = {};",
				to: "function sanitizeDeep(deep, accountability) {\n    const result = Object.create(null);",
			},
			{
				from: "    function parse(level, path = []) {\n        const parsedLevel = {};",
				to: "    function parse(level, path = []) {\n        const parsedLevel = Object.create(null);",
			},
			{
				from: "            set(result, path, merge({}, get(result, path, {}), parsedLevel));",
				to: "            set(result, path, merge(Object.create(null), get(result, path, Object.create(null)), parsedLevel));",
			},
		],
	},
]);

writeOverlay("GHSA-7vcx-mhxq-9j96", [
	{
		file: "services/assets.js",
		src: read("services/assets.js"),
		replace: [
			{
				from: "                throw new IllegalAssetTransformation(`Image is too large to be transformed, or image size couldn't be determined.`);\n            }\n            const { queue, process } = sharp.counters();",
				to: "                throw new IllegalAssetTransformation(`Image is too large to be transformed, or image size couldn't be determined.`);\n            }\n            const maxOut = env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'];\n            for (const step of transforms) {\n                const method = step[0];\n                if (method !== 'resize')\n                    continue;\n                const a = step[1];\n                const b = step[2];\n                const w = a && typeof a === 'object' ? a.width : a;\n                const h = a && typeof a === 'object' ? a.height : b;\n                if ((typeof w === 'number' && w > maxOut) || (typeof h === 'number' && h > maxOut)) {\n                    logger.warn('Requested transform output exceeds ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION.');\n                    throw new IllegalAssetTransformation(`Image is too large to be transformed, or image size couldn't be determined.`);\n                }\n            }\n            const { queue, process } = sharp.counters();",
			},
		],
	},
]);

writeOverlay("GHSA-xw72-c69j-h2rj", [
	{
		file: "controllers/utils.js",
		src: read("controllers/utils.js"),
		replace: [
			{
				from: "router.post('/hash/generate', asyncHandler(async (req, res) => {\n    if (!req.body?.string) {\n        throw new InvalidPayloadException(`\"string\" is required`);\n    }",
				to: "router.post('/hash/generate', asyncHandler(async (req, res) => {\n    if (!req.accountability?.user) {\n        throw new ForbiddenException();\n    }\n    if (!req.body?.string) {\n        throw new InvalidPayloadException(`\"string\" is required`);\n    }",
			},
			{
				from: "router.post('/hash/verify', asyncHandler(async (req, res) => {\n    if (!req.body?.string) {\n        throw new InvalidPayloadException(`\"string\" is required`);\n    }",
				to: "router.post('/hash/verify', asyncHandler(async (req, res) => {\n    if (!req.accountability?.user) {\n        throw new ForbiddenException();\n    }\n    if (!req.body?.string) {\n        throw new InvalidPayloadException(`\"string\" is required`);\n    }",
			},
		],
	},
]);

writeOverlay("GHSA-j5h6-vqc3-phqh", [
	{
		file: "request/validate-ip.js",
		src: read("request/validate-ip.js"),
		replace: [
			{
				from: "    if (env['IMPORT_IP_DENY_LIST'].includes('0.0.0.0')) {\n        const networkInterfaces = os.networkInterfaces();",
				to: "    if (env['IMPORT_IP_DENY_LIST'].includes('0.0.0.0')) {\n        if (ip === '::' || ip === '0.0.0.0' || String(ip).startsWith('0.'))\n            throw new Error(`Requested URL \"${url}\" resolves to a denied IP address`);\n        const networkInterfaces = os.networkInterfaces();",
			},
		],
	},
]);

writeOverlay("GHSA-7h45-q5jx-7r87", [
	{
		file: "services/shares.js",
		src: read("services/shares.js"),
		replace: [
			{
				from: "import { ForbiddenException, InvalidCredentialsException } from '../exceptions/index.js';",
				to: "import { ForbiddenException, InvalidCredentialsException, InvalidPayloadException } from '../exceptions/index.js';",
			},
			{
				from: "        await this.authorizationService.checkAccess('share', data['collection'], data['item']);\n        return super.createOne(data, opts);\n    }\n    async login(payload) {",
				to: "        await this.authorizationService.checkAccess('share', data['collection'], data['item']);\n        return super.createOne(data, opts);\n    }\n    async updateMany(keys, data, opts) {\n        if ('user_created' in data)\n            throw new InvalidPayloadException(`You can't change the \"user_created\" value manually`);\n        if ('role' in data && this.accountability && this.accountability.admin !== true)\n            throw new ForbiddenException();\n        return super.updateMany(keys, data, opts);\n    }\n    async login(payload) {",
			},
		],
	},
]);

writeOverlay("GHSA-p623-wgx3-wxp8", [
	{
		file: "services/files.js",
		src: read("services/files.js"),
		replace: [
			{
				from: "import { ItemsService } from './items.js';",
				to: "import { AuthorizationService } from './authorization.js';\nimport { ItemsService } from './items.js';",
			},
			{
				from: "    async uploadOne(stream, data, primaryKey, opts) {\n        const storage = await getStorage();",
				to: "    async uploadOne(stream, data, primaryKey, opts) {\n        if (this.accountability && this.accountability.admin !== true) {\n            if (primaryKey !== undefined) {\n                const authorizationService = new AuthorizationService({\n                    accountability: this.accountability,\n                    knex: this.knex,\n                    schema: this.schema,\n                });\n                await authorizationService.checkAccess('update', 'directus_files', primaryKey);\n            }\n            else {\n                const fileCreatePermissions = this.accountability?.permissions?.find((permission) => permission.collection === 'directus_files' && permission.action === 'create');\n                if (!fileCreatePermissions)\n                    throw new ForbiddenException();\n            }\n        }\n        const storage = await getStorage();",
			},
			{
				from: "    async createOne(data, opts) {\n        if (!data.type) {\n            throw new InvalidPayloadException(`\"type\" is required`);\n        }",
				to: "    async createOne(data, opts) {\n        if (this.accountability && this.accountability.admin !== true) {\n            const fileCreatePermissions = this.accountability?.permissions?.find((permission) => permission.collection === 'directus_files' && permission.action === 'create');\n            if (!fileCreatePermissions)\n                throw new ForbiddenException();\n        }\n        if (!data.type) {\n            throw new InvalidPayloadException(`\"type\" is required`);\n        }",
			},
		],
	},
]);

writeOverlay("GHSA-38hg-ww64-rrwc", [
	{
		file: "services/payload.js",
		src: read("services/payload.js"),
		replace: [
			{
				from: "        if (action === 'read') {\n            this.processAggregates(processedPayload);\n        }",
				to: "        if (action === 'read') {\n            await this.processAggregates(processedPayload);\n        }",
			},
			{
				from: "    processAggregates(payload) {\n        const aggregateKeys = Object.keys(payload[0]).filter((key) => key.includes('->'));\n        if (aggregateKeys.length) {\n            for (const item of payload) {\n                Object.assign(item, flat.unflatten(pick(item, aggregateKeys), { delimiter: '->' }));\n                aggregateKeys.forEach((key) => delete item[key]);\n            }\n        }\n    }",
				to: "    async processAggregates(payload) {\n        const aggregateKeys = Object.keys(payload[0] ?? {}).filter((key) => key.includes('->'));\n        if (aggregateKeys.length) {\n            const fieldEntries = this.schema.collections[this.collection].fields;\n            for (const item of payload) {\n                for (const key of aggregateKeys) {\n                    if (key in item === false)\n                        continue;\n                    const [operation, fieldName] = key.split('->');\n                    const aggregateResult = { [fieldName]: item[key] };\n                    if (fieldEntries[fieldName]?.special?.length > 0) {\n                        const newValue = await this.processField(fieldEntries[fieldName], aggregateResult, 'read', this.accountability);\n                        if (newValue !== undefined)\n                            aggregateResult[fieldName] = newValue;\n                    }\n                    if (!isPlainObject(item[operation]))\n                        item[operation] = {};\n                    item[operation][fieldName] = aggregateResult[fieldName];\n                    delete item[key];\n                }\n            }\n        }\n    }",
			},
		],
	},
]);

writeOverlay("GHSA-ph52-67fq-75wj", [
	{
		file: "services/graphql/index.js",
		src: read("services/graphql/index.js"),
		replace: [
			{
				from: "        const schema = this.getSchema();\n        const validationErrors = validate(schema, document, validationRules).map((validationError) => addPathToValidationError(validationError));",
				to: "        const schema = this.getSchema();\n        const aliasCap = (context) => {\n            let n = 0;\n            return {\n                Field(node) {\n                    if (!node.alias)\n                        return;\n                    n += 1;\n                    if (n > 50)\n                        context.reportError(new GraphQLError('Query too complex'));\n                },\n            };\n        };\n        const validationErrors = validate(schema, document, [...validationRules, aliasCap]).map((validationError) => addPathToValidationError(validationError));",
			},
		],
	},
]);

writeOverlay("GHSA-6q22-g298-grjh", [
	{
		file: "services/graphql/index.js",
		src: read("services/graphql/index.js"),
		replace: [
			{
				from: "            result = await execute({\n                schema,\n                document,\n                contextValue,",
				to: "            result = await execute({\n                schema,\n                document,\n                contextValue: contextValue ?? {},",
			},
			{
				from: "            server_health: {\n                type: GraphQLJSON,\n                resolve: async () => {\n                    const service = new ServerService({\n                        accountability: this.accountability,\n                        schema: this.schema,\n                    });\n                    return await service.health();\n                },\n            },",
				to: "            server_health: {\n                type: GraphQLJSON,\n                resolve: async (_source, _args, ctx) => {\n                    const bag = ctx ?? {};\n                    if (!bag.__directusHealth) {\n                        const service = new ServerService({\n                            accountability: this.accountability,\n                            schema: this.schema,\n                        });\n                        bag.__directusHealth = service.health();\n                    }\n                    return await bag.__directusHealth;\n                },\n            },",
			},
		],
	},
]);

writeOverlay("GHSA-mvv8-v4jj-g47j", [
	{
		file: "services/items.js",
		src: read("services/items.js"),
		replace: [
			{
				from: "                        data: snapshots && Array.isArray(snapshots) ? JSON.stringify(snapshots[index]) : JSON.stringify(snapshots),\n                        delta: await payloadService.prepareDelta(payloadWithTypeCasting),",
				to: "                        data: snapshots && Array.isArray(snapshots) ? await payloadService.prepareDelta(snapshots[index]) : await payloadService.prepareDelta(snapshots),\n                        delta: await payloadService.prepareDelta(payloadWithTypeCasting),",
			},
		],
	},
]);

const oauthRedirectCheck = `        if (redirect) {\n            let parsed;\n            try {\n                parsed = new URL(String(redirect), env['PUBLIC_URL']);\n            }\n            catch {\n                throw new InvalidPayloadException(\`URL "\${redirect}" can't be used to redirect after login\`);\n            }\n            let allowed;\n            try {\n                allowed = new URL(env['PUBLIC_URL']);\n            }\n            catch {\n                throw new InvalidPayloadException(\`URL "\${redirect}" can't be used to redirect after login\`);\n            }\n            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.protocol !== allowed.protocol || parsed.host !== allowed.host)\n                throw new InvalidPayloadException(\`URL "\${redirect}" can't be used to redirect after login\`);\n        }\n`;

writeOverlay("GHSA-cf45-hxwj-4cfj", [
	{
		file: "auth/drivers/oauth2.js",
		src: read("auth/drivers/oauth2.js"),
		replace: [
			{
				from: "import { InvalidConfigException, InvalidCredentialsException, InvalidProviderException, InvalidTokenException, ServiceUnavailableException, } from '../../exceptions/index.js';",
				to: "import { InvalidConfigException, InvalidCredentialsException, InvalidPayloadException, InvalidProviderException, InvalidTokenException, ServiceUnavailableException, } from '../../exceptions/index.js';",
			},
			{
				from: "        const { verifier, redirect, prompt } = tokenData;\n        const accountability = {",
				to: `        const { verifier, redirect, prompt } = tokenData;\n${oauthRedirectCheck}        const accountability = {`,
			},
		],
	},
	{
		file: "auth/drivers/openid.js",
		src: read("auth/drivers/openid.js"),
		replace: [
			{
				from: "import { InvalidConfigException, InvalidCredentialsException, InvalidProviderException, InvalidTokenException, ServiceUnavailableException, } from '../../exceptions/index.js';",
				to: "import { InvalidConfigException, InvalidCredentialsException, InvalidPayloadException, InvalidProviderException, InvalidTokenException, ServiceUnavailableException, } from '../../exceptions/index.js';",
			},
			{
				from: "        const { verifier, redirect, prompt } = tokenData;\n        const accountability = {",
				to: `        const { verifier, redirect, prompt } = tokenData;\n${oauthRedirectCheck}        const accountability = {`,
			},
		],
	},
	{
		file: "auth/drivers/saml.js",
		src: read("auth/drivers/saml.js"),
		replace: [
			{
				from: "import { InvalidCredentialsException, InvalidProviderException } from '../../exceptions/index.js';",
				to: "import { InvalidCredentialsException, InvalidPayloadException, InvalidProviderException } from '../../exceptions/index.js';",
			},
			{
				from: "        const relayState = req.body?.RelayState;\n        try {",
				to: "        const relayState = req.body?.RelayState;\n        if (relayState) {\n            let parsed;\n            try {\n                parsed = new URL(String(relayState), env['PUBLIC_URL']);\n            }\n            catch {\n                throw new InvalidPayloadException(`URL \"${relayState}\" can't be used to redirect after login`);\n            }\n            let allowed;\n            try {\n                allowed = new URL(env['PUBLIC_URL']);\n            }\n            catch {\n                throw new InvalidPayloadException(`URL \"${relayState}\" can't be used to redirect after login`);\n            }\n            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.protocol !== allowed.protocol || parsed.host !== allowed.host)\n                throw new InvalidPayloadException(`URL \"${relayState}\" can't be used to redirect after login`);\n        }\n        try {",
			},
		],
	},
]);

writeOverlay("GHSA-wxwm-3fxv-mrvx", [
	{
		file: "services/graphql/index.js",
		src: read("services/graphql/index.js"),
		replace: [
			{
				from: "            server_specs_graphql: {\n                type: GraphQLString,\n                args: {\n                    scope: new GraphQLEnumType({\n                        name: 'graphql_sdl_scope',\n                        values: {\n                            items: { value: 'items' },\n                            system: { value: 'system' },\n                        },\n                    }),\n                },\n                resolve: async (_, args) => {\n                    const service = new GraphQLService({\n                        schema: this.schema,\n                        accountability: this.accountability,\n                        scope: args['scope'] ?? 'items',\n                    });\n                    return service.getSchema('sdl');\n                },\n            },",
				to: "            ...env['GRAPHQL_INTROSPECTION'] !== false && {\n                server_specs_graphql: {\n                    type: GraphQLString,\n                    args: {\n                        scope: new GraphQLEnumType({\n                            name: 'graphql_sdl_scope',\n                            values: {\n                                items: { value: 'items' },\n                                system: { value: 'system' },\n                            },\n                        }),\n                    },\n                    resolve: async (_, args) => {\n                        const service = new GraphQLService({\n                            schema: this.schema,\n                            accountability: this.accountability,\n                            scope: args['scope'] ?? 'items',\n                        });\n                        return service.getSchema('sdl');\n                    },\n                },\n            },",
			},
		],
	},
	{
		file: "controllers/server.js",
		src: read("controllers/server.js"),
		replace: [
			{
				from: "import { format } from 'date-fns';\nimport { Router } from 'express';\nimport { RouteNotFoundException } from '../exceptions/index.js';\nimport { respond } from '../middleware/respond.js';\nimport { ServerService } from '../services/server.js';\nimport { SpecificationService } from '../services/specifications.js';\nimport asyncHandler from '../utils/async-handler.js';\nconst router = Router();\nrouter.get('/specs/oas', asyncHandler(async (req, res, next) => {\n    const service = new SpecificationService({\n        accountability: req.accountability,\n        schema: req.schema,\n    });\n    res.locals['payload'] = await service.oas.generate();\n    return next();\n}), respond);\nrouter.get('/specs/graphql/:scope?', asyncHandler(async (req, res) => {\n    const service = new SpecificationService({\n        accountability: req.accountability,\n        schema: req.schema,\n    });\n    const serverService = new ServerService({\n        accountability: req.accountability,\n        schema: req.schema,\n    });\n    const scope = req.params['scope'] || 'items';\n    if (['items', 'system'].includes(scope) === false)\n        throw new RouteNotFoundException(req.path);\n    const info = await serverService.serverInfo();\n    const result = await service.graphql.generate(scope);\n    const filename = info['project'].project_name + '_' + format(new Date(), 'yyyy-MM-dd') + '.graphql';\n    res.attachment(filename);\n    res.send(result);\n}));",
				to: "import { format } from 'date-fns';\nimport { Router } from 'express';\nimport env from '../env.js';\nimport { RouteNotFoundException } from '../exceptions/index.js';\nimport { respond } from '../middleware/respond.js';\nimport { ServerService } from '../services/server.js';\nimport { SpecificationService } from '../services/specifications.js';\nimport asyncHandler from '../utils/async-handler.js';\nconst router = Router();\nrouter.get('/specs/oas', asyncHandler(async (req, res, next) => {\n    const service = new SpecificationService({\n        accountability: req.accountability,\n        schema: req.schema,\n    });\n    res.locals['payload'] = await service.oas.generate();\n    return next();\n}), respond);\nif (env['GRAPHQL_INTROSPECTION'] !== false) {\n    router.get('/specs/graphql/:scope?', asyncHandler(async (req, res) => {\n        const service = new SpecificationService({\n            accountability: req.accountability,\n            schema: req.schema,\n        });\n        const serverService = new ServerService({\n            accountability: req.accountability,\n            schema: req.schema,\n        });\n        const scope = req.params['scope'] || 'items';\n        if (['items', 'system'].includes(scope) === false)\n            throw new RouteNotFoundException(req.path);\n        const info = await serverService.serverInfo();\n        const result = await service.graphql.generate(scope);\n        const filename = info['project'].project_name + '_' + format(new Date(), 'yyyy-MM-dd') + '.graphql';\n        res.attachment(filename);\n        res.send(result);\n    }));\n}",
			},
		],
	},
]);

writeOverlay("GHSA-wv3h-5fx7-966h", [
	{
		file: "request/validate-ip.js",
		src: read("request/validate-ip.js"),
		replace: [
			{
				from: "export const validateIP = async (ip, url) => {\n    const env = getEnv();",
				to: "export const validateIP = async (ip, url) => {\n    const mapped = String(ip).toLowerCase();\n    if (mapped.startsWith('::ffff:'))\n        ip = mapped.slice('::ffff:'.length);\n    const env = getEnv();",
			},
		],
	},
]);

writeOverlay("GHSA-5h38-6755-g83w", [
	{
		file: "services/mail/index.js",
		src: read("services/mail/index.js"),
		replace: [
			{
				from: "    async renderTemplate(template, variables) {\n        const customTemplatePath = path.resolve(env['EXTENSIONS_PATH'], 'templates', template + '.liquid');\n        const systemTemplatePath = path.join(__dirname, 'templates', template + '.liquid');\n        const templatePath = (await fse.pathExists(customTemplatePath)) ? customTemplatePath : systemTemplatePath;\n        if ((await fse.pathExists(templatePath)) === false) {\n            throw new InvalidPayloadException(`Template \"${template}\" doesn't exist.`);\n        }",
				to: "    async renderTemplate(template, variables) {\n        const customTemplatesDir = path.resolve(env['EXTENSIONS_PATH'], 'templates');\n        const systemTemplatesDir = path.join(__dirname, 'templates');\n        const customTemplatePath = path.resolve(customTemplatesDir, template + '.liquid');\n        const systemTemplatePath = path.resolve(systemTemplatesDir, template + '.liquid');\n        const isWithin = (dir, candidate) => candidate === dir || candidate.startsWith(dir + path.sep);\n        let templatePath = null;\n        if (isWithin(customTemplatesDir, customTemplatePath) && (await fse.pathExists(customTemplatePath)))\n            templatePath = customTemplatePath;\n        else if (isWithin(systemTemplatesDir, systemTemplatePath) && (await fse.pathExists(systemTemplatePath)))\n            templatePath = systemTemplatePath;\n        if (templatePath === null) {\n            throw new InvalidPayloadException(`Template \"${template}\" doesn't exist.`);\n        }",
			},
		],
	},
]);
