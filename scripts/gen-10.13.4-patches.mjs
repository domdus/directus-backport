import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIST = "/tmp/directus-10.13.4-api/dist";
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
	fs.writeFileSync(path.join(dir, "10.13.4.yml"), yaml);
	console.log(id, "ok", doc.length, "file(s)");
}

const publicAccountability = `{
                user: null,
                role: null,
                admin: false,
                app: false,
                ip: client.accountability?.ip ?? null,
                userAgent: client.accountability?.userAgent,
                origin: client.accountability?.origin,
            }`;

{
	const src = read("websocket/controllers/base.js");
	writeOverlay("GHSA-97xr-jchp-xm3c", [
		{
			file: "websocket/controllers/base.js",
			src,
			replace: [
				{
					from: `            logger.trace(\`WebSocket#\${client.uid} failed authentication\`);
            emitter.emitAction('websocket.auth.failure', { client });
            client.accountability = null;
            client.expires_at = null;`,
					to: `            logger.trace(\`WebSocket#\${client.uid} failed authentication\`);
            emitter.emitAction('websocket.auth.failure', { client });
            client.accountability = ${publicAccountability};
            client.expires_at = null;`,
				},
				{
					from: `        client.auth_timer = setTimeout(() => {
            client.accountability = null;
            client.expires_at = null;
            handleWebSocketError(client, new TokenExpiredError(), 'auth');`,
					to: `        client.auth_timer = setTimeout(() => {
            client.accountability = ${publicAccountability};
            client.expires_at = null;
            handleWebSocketError(client, new TokenExpiredError(), 'auth');`,
				},
			],
		},
	]);
}

{
	const src = read("utils/sanitize-query.js");
	writeOverlay("GHSA-gwvv-rr68-cmv6", [
		{
			file: "utils/sanitize-query.js",
			src,
			replace: [
				{
					from: `function sanitizeDeep(deep, accountability) {
    const logger = useLogger();
    const result = {};`,
					to: `function sanitizeDeep(deep, accountability) {
    const logger = useLogger();
    const result = Object.create(null);`,
				},
				{
					from: `    function parse(level, path = []) {
        const subQuery = {};
        const parsedLevel = {};`,
					to: `    function parse(level, path = []) {
        const subQuery = Object.create(null);
        const parsedLevel = Object.create(null);`,
				},
				{
					from: `            set(result, path, merge({}, get(result, path, {}), parsedLevel));`,
					to: `            set(result, path, merge(Object.create(null), get(result, path, Object.create(null)), parsedLevel));`,
				},
			],
		},
	]);
}

{
	const src = read("services/assets.js");
	writeOverlay("GHSA-7vcx-mhxq-9j96", [
		{
			file: "services/assets.js",
			src,
			replace: [
				{
					from: `                throw new IllegalAssetTransformationError({ invalidTransformations: ['width', 'height'] });
            }
            const { queue, process } = sharp.counters();`,
					to: `                throw new IllegalAssetTransformationError({ invalidTransformations: ['width', 'height'] });
            }
            const maxOut = env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'];
            for (const step of transforms) {
                const method = step[0];
                if (method !== 'resize')
                    continue;
                const a = step[1];
                const b = step[2];
                const w = a && typeof a === 'object' ? a.width : a;
                const h = a && typeof a === 'object' ? a.height : b;
                if ((typeof w === 'number' && w > maxOut) || (typeof h === 'number' && h > maxOut)) {
                    logger.warn('Requested transform output exceeds ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION.');
                    throw new IllegalAssetTransformationError({ invalidTransformations: ['width', 'height'] });
                }
            }
            const { queue, process } = sharp.counters();`,
				},
			],
		},
	]);
}

{
	const src = read("websocket/controllers/base.js");
	writeOverlay("GHSA-mww8-4gwh-rjfw", [
		{
			file: "websocket/controllers/base.js",
			src,
			replace: [
				{
					from: `        if (this.clients.size >= this.maxConnections) {
            logger.debug('WebSocket upgrade denied - max connections reached');
            socket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
            socket.destroy();
            return;
        }
        const env = useEnv();`,
					to: `        if (this.clients.size >= this.maxConnections) {
            logger.debug('WebSocket upgrade denied - max connections reached');
            socket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
            socket.destroy();
            return;
        }
        const originHeader = request.headers['origin'];
        if (originHeader) {
            let originUrl;
            try {
                originUrl = new URL(originHeader);
            }
            catch {
                logger.debug(\`WebSocket upgrade denied - disallowed Origin: \${originHeader}\`);
                socket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
                socket.destroy();
                return;
            }
            const envOrigin = useEnv();
            const host = request.headers['host'];
            const publicUrl = envOrigin['PUBLIC_URL'];
            const sameHost = Boolean(host) && originUrl.host === host;
            const samePublic = typeof publicUrl === 'string' && URL.canParse(publicUrl) && new URL(publicUrl).origin === originUrl.origin;
            let corsMatch = false;
            if (envOrigin['CORS_ENABLED'] === true) {
                const corsOrigin = envOrigin['CORS_ORIGIN'];
                if (corsOrigin === true)
                    corsMatch = true;
                else if (typeof corsOrigin === 'string' && corsOrigin !== '*')
                    corsMatch = corsOrigin === originHeader;
                else if (Array.isArray(corsOrigin))
                    corsMatch = corsOrigin.includes(originHeader);
            }
            if (!sameHost && !samePublic && !corsMatch) {
                logger.debug(\`WebSocket upgrade denied - disallowed Origin: \${originHeader}\`);
                socket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
                socket.destroy();
                return;
            }
        }
        const env = useEnv();`,
				},
			],
		},
	]);
}

{
	const types = read("database/helpers/geometry/types.js");
	const pg = read("database/helpers/geometry/dialects/postgres.js");
	writeOverlay("GHSA-chfm-g7r3-vv42", [
		{
			file: "database/helpers/geometry/types.js",
			src: types,
			replace: [
				{
					from: `    createColumn(table, field) {
        const type = field.type.split('.')[1] ?? 'geometry';
        return table.specificType(field.field, type);
    }`,
					to: `    createColumn(table, field) {
        const rawType = field.type.split('.')[1] ?? 'geometry';
        const allowedGeo = ['geometry', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];
        const type = allowedGeo.find((value) => value.toLowerCase() === String(rawType).toLowerCase()) ?? 'geometry';
        return table.specificType(field.field, type);
    }`,
				},
			],
		},
		{
			file: "database/helpers/geometry/dialects/postgres.js",
			src: pg,
			replace: [
				{
					from: `    createColumn(table, field) {
        const type = field.type.split('.')[1] ?? 'geometry';
        return table.specificType(field.field, \`geometry(\${type}, 4326)\`);
    }`,
					to: `    createColumn(table, field) {
        const rawType = field.type.split('.')[1] ?? 'geometry';
        const allowedGeo = ['geometry', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];
        const type = allowedGeo.find((value) => value.toLowerCase() === String(rawType).toLowerCase()) ?? 'geometry';
        return table.specificType(field.field, \`geometry(\${type}, 4326)\`);
    }`,
				},
			],
		},
	]);
}

{
	const src = read("services/tus/data-store.js");
	writeOverlay("GHSA-3742-46gx-c8cc", [
		{
			file: "services/tus/data-store.js",
			src,
			replace: [
				{
					from: `            storage: this.location,
        };
        // If no folder is specified, we'll use the default folder from the settings if it exists
        if ('folder' in fileData === false) {`,
					to: `            storage: this.location,
        };
        if (fileData.filename_disk) {
            const disk = String(fileData.filename_disk).replaceAll('\\\\', '/');
            if (disk.includes('..') || disk.startsWith('/') || disk.includes('\\0'))
                throw ERRORS.INVALID_METADATA;
            fileData.filename_disk = disk.split('/').filter(Boolean).join('/');
        }
        // If no folder is specified, we'll use the default folder from the settings if it exists
        if ('folder' in fileData === false) {`,
				},
			],
		},
	]);
}

{
	const src = read("services/tus/data-store.js");
	writeOverlay("GHSA-xjxq-pj7h-g676", [
		{
			file: "services/tus/data-store.js",
			src,
			replace: [
				{
					from: `        // If this is a new file upload, we need to generate a new primary key and DB record
        const primaryKey = await itemsService.createOne(fileData, { emitEvents: false });
        // Set the file id, so it is available to be sent as a header on upload creation / resume
        if (!upload.metadata['id']) {
            upload.metadata['id'] = primaryKey;
        }`,
					to: `        if (existingFile && upload.metadata['id']) {
            await itemsService.readOne(upload.metadata['id']);
        }
        // If this is a new file upload, we need to generate a new primary key and DB record
        const primaryKey = await itemsService.createOne(fileData, { emitEvents: false });
        // Set the file id, so it is available to be sent as a header on upload creation / resume
        if (!existingFile) {
            upload.metadata['id'] = primaryKey;
        }`,
				},
			],
		},
	]);
}

{
	const src = read("services/graphql/index.js");
	writeOverlay("GHSA-g293-vf99-xv36", [
		{
			file: "services/graphql/index.js",
			src,
			replace: [
				{
					from: `const validationRules = Array.from(specifiedRules);
if (env['GRAPHQL_INTROSPECTION'] === false) {
    validationRules.push(NoSchemaIntrospectionCustomRule);
}`,
					to: `const validationRules = Array.from(specifiedRules);
if (env['GRAPHQL_INTROSPECTION'] === false) {
    validationRules.push(NoSchemaIntrospectionCustomRule);
}
const sensitiveMutations = new Set(['users_register', 'users_invite', 'auth_login', 'auth_password_request', 'auth_password_reset', 'users_me_tfa_enable', 'users_me_tfa_disable', 'users_me_tfa_generate']);
validationRules.push((context) => {
    const counts = new Map();
    return {
        Field(node) {
            if (context.getOperation()?.operation !== 'mutation')
                return;
            const name = node.name.value;
            if (!sensitiveMutations.has(name) && !name.includes('users_register') && !name.includes('password') && !name.includes('invite') && !name.includes('tfa'))
                return;
            const n = (counts.get(name) ?? 0) + 1;
            counts.set(name, n);
            if (n > 1)
                context.reportError(new GraphQLError(\`"\${name}" can only be used once per request\`));
        },
    };
});`,
				},
			],
		},
	]);
}

{
	const src = read("controllers/utils.js");
	writeOverlay("GHSA-xw72-c69j-h2rj", [
		{
			file: "controllers/utils.js",
			src,
			replace: [
				{
					from: `import { InvalidPayloadError, InvalidQueryError, UnsupportedMediaTypeError } from '@directus/errors';`,
					to: `import { ForbiddenError, InvalidPayloadError, InvalidQueryError, UnsupportedMediaTypeError } from '@directus/errors';`,
				},
				{
					from: `router.post('/hash/generate', asyncHandler(async (req, res) => {
    if (!req.body?.string) {
        throw new InvalidPayloadError({ reason: \`"string" is required\` });
    }`,
					to: `router.post('/hash/generate', asyncHandler(async (req, res) => {
    if (!req.accountability?.user) {
        throw new ForbiddenError();
    }
    if (!req.body?.string) {
        throw new InvalidPayloadError({ reason: \`"string" is required\` });
    }`,
				},
				{
					from: `router.post('/hash/verify', asyncHandler(async (req, res) => {
    if (!req.body?.string) {
        throw new InvalidPayloadError({ reason: \`"string" is required\` });
    }`,
					to: `router.post('/hash/verify', asyncHandler(async (req, res) => {
    if (!req.accountability?.user) {
        throw new ForbiddenError();
    }
    if (!req.body?.string) {
        throw new InvalidPayloadError({ reason: \`"string" is required\` });
    }`,
				},
			],
		},
	]);
}

{
	const src = read("request/is-denied-ip.js");
	writeOverlay("GHSA-j5h6-vqc3-phqh", [
		{
			file: "request/is-denied-ip.js",
			src,
			replace: [
				{
					from: `    if (ipDenyList.includes('0.0.0.0')) {
        const networkInterfaces = os.networkInterfaces();`,
					to: `    if (ipDenyList.includes('0.0.0.0')) {
        if (ipInNetworks(ip, ['0.0.0.0/8', '::']))
            return true;
        const networkInterfaces = os.networkInterfaces();`,
				},
			],
		},
	]);
}

{
	const src = read("utils/get-cache-key.js");
	writeOverlay("GHSA-c6w9-5g5j-jh2p", [
		{
			file: "utils/get-cache-key.js",
			src,
			replace: [
				{
					from: `    const info = {
        version,
        user: req.accountability?.user || null,
        path,
        query: isGraphQl ? getGraphqlQueryAndVariables(req) : req.sanitizedQuery,
    };`,
					to: `    const info = {
        version,
        user: req.accountability?.user || null,
        role: req.accountability?.role || null,
        admin: req.accountability?.admin || false,
        app: req.accountability?.app || false,
        path,
        query: isGraphQl ? getGraphqlQueryAndVariables(req) : req.sanitizedQuery,
        ...req.accountability?.share && { share: req.accountability.share },
    };`,
				},
			],
		},
	]);
}

{
	const src = read("services/shares.js");
	writeOverlay("GHSA-7h45-q5jx-7r87", [
		{
			file: "services/shares.js",
			src,
			replace: [
				{
					from: `import { ForbiddenError, InvalidCredentialsError } from '@directus/errors';`,
					to: `import { ForbiddenError, InvalidCredentialsError, InvalidPayloadError } from '@directus/errors';`,
				},
				{
					from: `        await this.authorizationService.checkAccess('share', data['collection'], data['item']);
        return super.createOne(data, opts);
    }
    async login(payload, options) {`,
					to: `        await this.authorizationService.checkAccess('share', data['collection'], data['item']);
        return super.createOne(data, opts);
    }
    async updateMany(keys, data, opts) {
        if ('user_created' in data)
            throw new InvalidPayloadError({ reason: \`You can't change the "user_created" value manually\` });
        if ('role' in data && this.accountability && this.accountability.admin !== true)
            throw new ForbiddenError();
        return super.updateMany(keys, data, opts);
    }
    async login(payload, options) {`,
				},
			],
		},
	]);
}

{
	const src = read("services/users.js");
	writeOverlay("GHSA-8xp8-xrh2-88vr", [
		{
			file: "services/users.js",
			src,
			replace: [
				{
					from: `            const mailService = new MailService(serviceOptions);
            const payload = { email: input.email, scope: 'pending-registration' };`,
					to: `            const mailService = new MailService(serviceOptions);
            const verificationEmail = user?.email ?? input.email;
            const payload = { email: verificationEmail, scope: 'pending-registration' };`,
				},
				{
					from: `                to: input.email,
                subject: 'Verify your email address', // TODO: translate after theres support for internationalized emails
                template: {
                    name: 'user-registration',
                    data: {
                        url: verificationUrl,
                        email: input.email,`,
					to: `                to: verificationEmail,
                subject: 'Verify your email address', // TODO: translate after theres support for internationalized emails
                template: {
                    name: 'user-registration',
                    data: {
                        url: verificationUrl,
                        email: verificationEmail,`,
				},
			],
		},
	]);
}

{
	const src = read("services/settings.js");
	writeOverlay("GHSA-788p-cvgf-q973", [
		{
			file: "services/settings.js",
			src,
			replace: [
				{
					from: `import { ItemsService } from './items.js';
export class SettingsService extends ItemsService {
    constructor(options) {
        super('directus_settings', options);
    }
}`,
					to: `import { InvalidPayloadError } from '@directus/errors';
import { ItemsService } from './items.js';
export class SettingsService extends ItemsService {
    constructor(options) {
        super('directus_settings', options);
    }
    assertSafeProjectColor(data) {
        if (!data || !('project_color' in data) || data.project_color == null)
            return;
        if (!/^#[0-9A-Fa-f]{3,8}$/.test(String(data.project_color)))
            throw new InvalidPayloadError({ reason: \`"project_color" must be a hex color\` });
    }
    async createOne(data, opts) {
        this.assertSafeProjectColor(data);
        return super.createOne(data, opts);
    }
    async updateMany(keys, data, opts) {
        this.assertSafeProjectColor(data);
        return super.updateMany(keys, data, opts);
    }
    async upsertSingleton(data, opts) {
        this.assertSafeProjectColor(data);
        return super.upsertSingleton(data, opts);
    }
}`,
				},
			],
		},
	]);
}

{
	const src = read("services/files.js");
	writeOverlay("GHSA-p623-wgx3-wxp8", [
		{
			file: "services/files.js",
			src,
			replace: [
				{
					from: `import { extractMetadata } from './files/lib/extract-metadata.js';
import { ItemsService } from './items.js';`,
					to: `import { extractMetadata } from './files/lib/extract-metadata.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';`,
				},
				{
					from: `    async uploadOne(stream, data, primaryKey, opts) {
        const storage = await getStorage();`,
					to: `    async uploadOne(stream, data, primaryKey, opts) {
        if (this.accountability) {
            const authorizationService = new AuthorizationService({
                accountability: this.accountability,
                knex: this.knex,
                schema: this.schema,
            });
            if (primaryKey !== undefined) {
                await authorizationService.checkAccess('update', 'directus_files', primaryKey);
            }
            else {
                await authorizationService.checkAccess('create', 'directus_files');
            }
        }
        const storage = await getStorage();`,
				},
				{
					from: `    async createOne(data, opts) {
        if (!data.type) {
            throw new InvalidPayloadError({ reason: \`"type" is required\` });
        }`,
					to: `    async createOne(data, opts) {
        if (this.accountability) {
            const authorizationService = new AuthorizationService({
                accountability: this.accountability,
                knex: this.knex,
                schema: this.schema,
            });
            await authorizationService.checkAccess('create', 'directus_files');
        }
        if (!data.type) {
            throw new InvalidPayloadError({ reason: \`"type" is required\` });
        }`,
				},
			],
		},
	]);
}

{
	const src = read("websocket/controllers/graphql.js");
	writeOverlay("GHSA-ff8w-8crv-9rcf", [
		{
			file: "websocket/controllers/graphql.js",
			src,
			replace: [
				{
					from: `import { CloseCode, MessageType, makeServer } from 'graphql-ws';`,
					to: `import { CloseCode, MessageType, makeServer } from 'graphql-ws';
import { GraphQLError, parse } from 'graphql';`,
				},
				{
					from: `                return service.getSchema();
            },
        });`,
					to: `                return service.getSchema();
            },
            async onSubscribe(_ctx, _id, payload) {
                const env = useEnv();
                try {
                    parse(payload.query, { maxTokens: Number(env['GRAPHQL_QUERY_TOKEN_LIMIT']) || 5000 });
                }
                catch {
                    return [new GraphQLError('Failed to parse GraphQL document.')];
                }
            },
        });`,
				},
			],
		},
	]);
}

{
	const src = read("services/mail/index.js");
	writeOverlay("GHSA-5h38-6755-g83w", [
		{
			file: "services/mail/index.js",
			src,
			replace: [
				{
					from: `    async renderTemplate(template, variables) {
        const customTemplatePath = path.resolve(env['EMAIL_TEMPLATES_PATH'], template + '.liquid');
        const systemTemplatePath = path.join(__dirname, 'templates', template + '.liquid');
        const templatePath = (await fse.pathExists(customTemplatePath)) ? customTemplatePath : systemTemplatePath;
        if ((await fse.pathExists(templatePath)) === false) {
            throw new InvalidPayloadError({ reason: \`Template "\${template}" doesn't exist\` });
        }`,
					to: `    async renderTemplate(template, variables) {
        const customTemplatesDir = path.resolve(env['EMAIL_TEMPLATES_PATH']);
        const systemTemplatesDir = path.join(__dirname, 'templates');
        const customTemplatePath = path.resolve(customTemplatesDir, template + '.liquid');
        const systemTemplatePath = path.resolve(systemTemplatesDir, template + '.liquid');
        const isWithin = (dir, candidate) => candidate === dir || candidate.startsWith(dir + path.sep);
        let templatePath = null;
        if (isWithin(customTemplatesDir, customTemplatePath) && (await fse.pathExists(customTemplatePath)))
            templatePath = customTemplatePath;
        else if (isWithin(systemTemplatesDir, systemTemplatePath) && (await fse.pathExists(systemTemplatePath)))
            templatePath = systemTemplatePath;
        if (templatePath === null) {
            throw new InvalidPayloadError({ reason: \`Template "\${template}" doesn't exist\` });
        }`,
				},
			],
		},
	]);
}
