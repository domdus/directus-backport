// Overlays for advisories that upstream fixed on 10.x / 11.x (not 12.x) but that are
// still open on the older pins. 11.17.4 already contains every one of these fixes.
//
// Stock trees: `npm pack @directus/api@<ver>` for each pin, extracted under DX_BP
// (default /tmp/dx-bp): api-10 = @directus/api 21.0.2 (10.13.4), api-9 = 9.26.0.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CATALOG = path.resolve(import.meta.dirname, "../catalog");
const ROOT = process.env.DX_BP ?? "/tmp/dx-bp";
const DIST = {
	"10.13.4": path.join(ROOT, "api-10/dist"),
	"9.26.0": path.join(ROOT, "api-9/dist"),
};

const sha = (s) => createHash("sha256").update(s).digest("hex");
const read = (pin, rel) => fs.readFileSync(path.join(DIST[pin], rel), "utf8");
const L = (...lines) => lines.join("\n");

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

function writeOverlay(id, pin, entries) {
	const dir = path.join(CATALOG, "patches", id);
	fs.mkdirSync(dir, { recursive: true });
	const yaml = entries
		.map(({ file, replace }) => {
			const src = read(pin, file);
			const after = apply(src, replace);
			let s = `- file: ${JSON.stringify(`@directus/api/dist/${file}`)}\n`;
			s += `  before_sha256: ${JSON.stringify(sha(src))}\n`;
			s += `  after_sha256: ${JSON.stringify(sha(after))}\n`;
			s += `  replace:\n`;
			for (const r of replace) {
				s += `    - from: ${JSON.stringify(r.from)}\n`;
				s += `      to: ${JSON.stringify(r.to)}\n`;
			}
			return s;
		})
		.join("");
	fs.writeFileSync(path.join(dir, `${pin}.yml`), yaml);
	console.log(id, pin, "ok", entries.length, "file(s)");
}

const both = (fn) => {
	for (const pin of ["10.13.4", "9.26.0"]) fn(pin, pin === "9.26.0");
};

// --- GHSA-mv33-9f6j-pfmc: replacement upload writes temp_<filename_disk> before the permission check (10.13.4) ---
writeOverlay("GHSA-mv33-9f6j-pfmc", "10.13.4", [
	{
		file: "services/files.js",
		replace: [
			{
				from: "        const tempFilenameDisk = 'temp_' + payload.filename_disk;",
				to: "        const tempFilenameDisk = 'temp_' + primaryKey + (fileExtension || '');",
			},
			{
				from: L(
					"        if (isReplacement === true) {",
					"            await this.updateOne(primaryKey, payload, { emitEvents: false });",
					"            // delete the previously saved file and thumbnails to ensure they're generated fresh",
					"            for await (const filepath of disk.list(String(primaryKey))) {",
					"                await disk.delete(filepath);",
					"            }",
					"            // Upgrade the temp file to the final filename",
					"            await disk.move(tempFilenameDisk, payload.filename_disk);",
					"        }",
				),
				to: L(
					"        if (isReplacement === true) {",
					"            try {",
					"                await this.updateOne(primaryKey, payload, { emitEvents: false });",
					"                // delete the previously saved file and thumbnails to ensure they're generated fresh",
					"                for await (const filepath of disk.list(String(primaryKey))) {",
					"                    await disk.delete(filepath);",
					"                }",
					"                // Upgrade the temp file to the final filename",
					"                await disk.move(tempFilenameDisk, payload.filename_disk);",
					"            }",
					"            catch (err) {",
					"                await cleanUp();",
					"                throw err;",
					"            }",
					"        }",
				),
			},
		],
	},
]);

// --- GHSA-393c-p46r-7c95: filename_disk can be pointed at another file (10.13.4) ---
{
	const guard = (indent) =>
		L(
			`${indent}const normalizeFilenameDisk = (value) => path.relative(path.sep, path.resolve(path.sep, String(value))).split(path.sep).join('/');`,
		);
	writeOverlay("GHSA-393c-p46r-7c95", "10.13.4", [
		{
			file: "services/files.js",
			replace: [
				{
					from: "    async createOne(data, opts) {",
					to: L(
						"    async createOne(data, opts) {",
						"        if (this.accountability && data?.filename_disk) {",
						guard("            "),
						"            data.filename_disk = normalizeFilenameDisk(data.filename_disk);",
						"            const taken = await this.knex.select('id').from('directus_files').where({ filename_disk: data.filename_disk }).first();",
						"            if (taken)",
						"                throw new ForbiddenError();",
						"        }",
					),
				},
				{
					from: L("    /**", "     * Delete multiple files", "     */", "    async deleteMany(keys) {"),
					to: L(
						"    async updateMany(keys, data, opts) {",
						"        if (this.accountability && data && typeof data === 'object' && data.filename_disk) {",
						"            if (keys.length !== 1)",
						"                throw new InvalidPayloadError({ reason: '\"filename_disk\" cannot be modified in bulk operations' });",
						guard("            "),
						"            data = { ...data, filename_disk: normalizeFilenameDisk(data.filename_disk) };",
						"            const taken = await this.knex.select('id').from('directus_files').where({ filename_disk: data.filename_disk }).whereNot('id', keys[0]).first();",
						"            if (taken)",
						"                throw new ForbiddenError();",
						"        }",
						"        return super.updateMany(keys, data, opts);",
						"    }",
						"    /**",
						"     * Delete multiple files",
						"     */",
						"    async deleteMany(keys) {",
					),
				},
			],
		},
	]);
}

// --- GHSA-8m32-p958-jg99: Cross-Origin-Opener-Policy header ---
both((pin) => {
	writeOverlay("GHSA-8m32-p958-jg99", pin, [
		{
			file: "app.js",
			replace: [
				{
					from: L(
						"        app.use(helmet.hsts(getConfigFromEnv('HSTS_', ['HSTS_ENABLED'])));",
						"    }",
						"    await emitter.emitInit('app.before', { app });",
					),
					to: L(
						"        app.use(helmet.hsts(getConfigFromEnv('HSTS_', ['HSTS_ENABLED'])));",
						"    }",
						"    if (env['CROSS_ORIGIN_OPENER_POLICY_ENABLED'] !== false && env['CROSS_ORIGIN_OPENER_POLICY_ENABLED'] !== 'false') {",
						"        app.use(helmet.crossOriginOpenerPolicy({ policy: env['CROSS_ORIGIN_OPENER_POLICY'] ?? 'same-origin-allow-popups' }));",
						"    }",
						"    await emitter.emitInit('app.before', { app });",
					),
				},
			],
		},
	]);
});

// --- GHSA-jr94-gj3h-c8rf: reset URL is validated after the user lookup (timing oracle) ---
both((pin, nine) => {
	const forbidden = nine ? "ForbiddenException()" : "ForbiddenError()";
	const urlCheck = nine
		? [
				"        if (url && isUrlAllowed(url, env['PASSWORD_RESET_URL_ALLOW_LIST']) === false) {",
				'            throw new InvalidPayloadException(`Url "${url}" can\'t be used to reset passwords.`);',
				"        }",
			]
		: [
				"        if (url && isUrlAllowed(url, env['PASSWORD_RESET_URL_ALLOW_LIST']) === false) {",
				'            throw new InvalidPayloadError({ reason: `URL "${url}" can\'t be used to reset passwords` });',
				"        }",
			];
	const lookup = [
		"        const user = await this.getUserByEmail(email);",
		"        if (user?.status !== 'active') {",
		"            await stall(STALL_TIME, timeStart);",
		`            throw new ${forbidden};`,
		"        }",
	];
	writeOverlay("GHSA-jr94-gj3h-c8rf", pin, [
		{
			file: "services/users.js",
			replace: [{ from: L(...lookup, ...urlCheck), to: L(...urlCheck, ...lookup) }],
		},
	]);
});

// --- GHSA-3573-4c68-g8cc: SAML RelayState is not validated on the ACS callback (10.13.4) ---
// 9.26.0 has no overlay: the GHSA-cf45-hxwj-4cfj overlay for 9.26.0 already validates RelayState there.
writeOverlay("GHSA-3573-4c68-g8cc", "10.13.4", [
	{
		file: "auth/drivers/saml.js",
		replace: [
			{
				from: L(
					"        const relayState = req.body?.RelayState;",
					"        const authMode = (env[`AUTH_${providerName.toUpperCase()}_MODE`] ?? 'session');",
				),
				to: L(
					"        const relayState = req.body?.RelayState;",
					"        if (relayState && isLoginRedirectAllowed(relayState, providerName) === false) {",
					'            throw new InvalidPayloadError({ reason: `URL "${relayState}" can\'t be used to redirect after login` });',
					"        }",
					"        const authMode = (env[`AUTH_${providerName.toUpperCase()}_MODE`] ?? 'session');",
				),
			},
		],
	},
]);

// --- GHSA-8jpw-gpr4-8cmh: concealed fields are matched by ?search ---
both((pin) => {
	writeOverlay("GHSA-8jpw-gpr4-8cmh", pin, [
		{
			file: "utils/apply-query.js",
			replace: [
				{
					from: L("    dbQuery.andWhere(function () {", "        " + (pin === "9.26.0" ? "fields" : "let needsFallbackCondition = true;\n        fields") + ".forEach(([name, field]) => {"),
					to: L(
						"    dbQuery.andWhere(function () {",
						"        " +
							(pin === "9.26.0" ? "fields" : "let needsFallbackCondition = true;\n        fields") +
							".forEach(([name, field]) => {",
						"            if (Array.isArray(field.special) && field.special.includes('conceal'))",
						"                return;",
					),
				},
			],
		},
	]);
});

// --- GHSA-7wq3-jr35-275c: ?search matches fields the role cannot read ---
both((pin, nine) => {
	const sig = nine
		? "export async function applySearch(schema, dbQuery, searchQuery, collection) {"
		: "export async function applySearch(knex, schema, dbQuery, searchQuery, collection) {";
	const sigTo = sig.replace("collection) {", "collection, allowedFields) {");
	const call = nine
		? "        applySearch(schema, dbQuery, query.search, collection);"
		: "        applySearch(knex, schema, dbQuery, query.search, collection);";
	const metaCall = nine
		? "            applySearch(this.schema, dbQuery, query.search, collection);"
		: "            applySearch(this.knex, this.schema, dbQuery, query.search, collection);";
	const fieldsLine = "    const fields = Object.entries(schema.collections[collection].fields);";
	const filterFields = L(
		"    let fields = Object.entries(schema.collections[collection].fields);",
		"    if (allowedFields !== undefined) {",
		"        const allowed = allowedFields === null ? [] : typeof allowedFields === 'string' ? allowedFields.split(',') : allowedFields;",
		"        if (!allowed.includes('*'))",
		"            fields = fields.filter(([name]) => allowed.includes(name));",
		"    }",
	);
	writeOverlay("GHSA-7wq3-jr35-275c", pin, [
		{
			file: "utils/apply-query.js",
			replace: [
				{ from: call, to: call.replace("collection);", "collection, query.__backportSearchFields);") },
				nine
					? { from: L(sig, fieldsLine), to: L(sigTo, filterFields) }
					: {
							from: L(sig, "    const { number: numberHelper } = getHelpers(knex);", fieldsLine),
							to: L(sigTo, "    const { number: numberHelper } = getHelpers(knex);", filterFields),
						},
			],
		},
		{
			file: "services/meta.js",
			replace: [
				{
					from: metaCall,
					to: metaCall.replace(
						"collection);",
						"collection, this.accountability && this.accountability.admin !== true ? (this.accountability.permissions?.find((permission) => permission.action === 'read' && permission.collection === collection)?.fields ?? null) : undefined);",
					),
				},
			],
		},
		{
			file: "services/authorization.js",
			replace: [
				{
					from: L("        applyFilters(ast, this.accountability);", "        return ast;"),
					to: L(
						"        applyFilters(ast, this.accountability);",
						"        if (ast.query?.search && this.accountability && this.accountability.admin !== true) {",
						"            const rootPermission = permissionsForCollections.find((permission) => permission.collection === ast.name);",
						"            ast.query.__backportSearchFields = rootPermission?.fields ?? null;",
						"        }",
						"        return ast;",
					),
				},
			],
		},
	]);
});

// --- GHSA-9x5g-62gj-wqf2: deleting a field leaves it in directus_permissions.fields ---
both((pin) => {
	const anchor = "                await trx('directus_fields').delete().where({ collection, field });";
	writeOverlay("GHSA-9x5g-62gj-wqf2", pin, [
		{
			file: "services/fields.js",
			replace: [
				{
					from: anchor,
					to: L(
						anchor,
						"                const permissionRows = await trx",
						"                    .select('id', 'fields')",
						"                    .from('directus_permissions')",
						"                    .where('collection', collection)",
						"                    .andWhere('fields', 'like', '%' + field + '%');",
						"                for (const permissionRow of permissionRows) {",
						"                    const current = String(permissionRow.fields ?? '').split(',');",
						"                    if (!current.includes(field))",
						"                        continue;",
						"                    const next = current.filter((value) => value !== field).join(',');",
						"                    await trx('directus_permissions')",
						"                        .update({ fields: next.length > 0 ? next : null })",
						"                        .where('id', permissionRow.id);",
						"                }",
					),
				},
			],
		},
	]);
});

// --- GHSA-7cvf-pxgp-42fc: manual trigger flows run without checking access to the items ---
both((pin, nine) => {
	const forbidden = nine ? "new exceptions.ForbiddenException()" : "new ForbiddenError()";
	const from = L(
		"                    if (!enabledCollections.includes(targetCollection)) {",
		"                        logger.warn(`Specified collection must be one of: ${enabledCollections.join(', ')}.`);",
		`                        throw ${forbidden};`,
		"                    }",
	);
	// 9.26.0's manual handler is a plain function; the webhook controller awaits it either way.
	const makeAsync = nine
		? [
				{
					from: L("                const handler = (data, context) => {", "                    const enabledCollections = flow.options?.['collections'] ?? [];"),
					to: L("                const handler = async (data, context) => {", "                    const enabledCollections = flow.options?.['collections'] ?? [];"),
				},
			]
		: [];
	writeOverlay("GHSA-7cvf-pxgp-42fc", pin, [
		{
			file: "flows.js",
			replace: [
				...makeAsync,
				{
					from,
					to: L(
						from,
						"                    const targetKeys = data?.['body']?.keys;",
						"                    const requireSelection = flow.options?.['requireSelection'] ?? true;",
						"                    if (!Array.isArray(targetKeys)) {",
						'                        logger.warn(`Manual trigger requires "keys" to be specified in the payload`);',
						`                        throw ${forbidden};`,
						"                    }",
						"                    if (requireSelection && targetKeys.length === 0) {",
						"                        logger.warn(`Manual trigger requires at least one key to be specified in the payload`);",
						`                        throw ${forbidden};`,
						"                    }",
						"                    const triggerAccountability = context?.['accountability'];",
						"                    if (!triggerAccountability) {",
						"                        logger.warn(`Manual flows are only triggerable when authenticated`);",
						`                        throw ${forbidden};`,
						"                    }",
						"                    if (triggerAccountability.admin !== true && targetKeys.length > 0) {",
						"                        const triggerSchema = context?.['schema'] ?? (await getSchema());",
						"                        const primaryField = triggerSchema.collections[targetCollection]?.primary;",
						"                        if (!primaryField) {",
						`                            throw ${forbidden};`,
						"                        }",
						"                        const itemsService = new services.ItemsService(targetCollection, {",
						"                            schema: triggerSchema,",
						"                            accountability: triggerAccountability,",
						"                            knex: context?.['database'] ?? getDatabase(),",
						"                        });",
						"                        const readable = await itemsService.readMany(targetKeys, { fields: [primaryField] }, { emitEvents: false });",
						"                        const allowedKeys = readable.map((item) => String(item[primaryField]));",
						"                        if (targetKeys.some((key) => !allowedKeys.includes(String(key)))) {",
						"                            logger.warn(`Triggering keys ${targetKeys} is not allowed`);",
						`                            throw ${forbidden};`,
						"                        }",
						"                    }",
					),
				},
			],
		},
	]);
});

// --- GHSA-rmjh-cf9q-pv7q: exact version in the OpenAPI info.version ---
both((pin, nine) => {
	const imp = nine ? "import { version } from '../utils/package.js';" : "import { version } from 'directus/version';";
	writeOverlay("GHSA-rmjh-cf9q-pv7q", pin, [
		{
			file: "services/specifications.js",
			replace: [
				{ from: imp, to: "import { createHash } from 'node:crypto';" },
				{
					from: "                version: version,",
					to: "                version: createHash('sha1').update(JSON.stringify({ now: new Date().toISOString(), user: this.accountability?.user ?? null })).digest('hex'),",
				},
			],
		},
	]);
});

// --- GHSA-j8xj-7jff-46mx: storage read stream opened before the transform is validated ---
both((pin, nine) => {
	const open = "            const readStream = await storage.location(file.storage).read(file.filename_disk, range);";
	const each = "            transforms.forEach(([method, ...args]) => transformer[method].apply(transformer, args));";
	const src = read(pin, "services/assets.js");
	const start = src.indexOf(open);
	const end = src.indexOf(each, start) + each.length;
	const block = src.slice(start, end);
	if (start < 0 || end < start) throw new Error("assets.js transform block not found");
	const moved = block.slice(open.length + 1) + "\n" + open;
	writeOverlay("GHSA-j8xj-7jff-46mx", pin, [{ file: "services/assets.js", replace: [{ from: block, to: moved }] }]);
});

// --- GHSA-rv78-qqrq-73m5: HEAD requests leave the storage stream unconsumed ---
both((pin) => {
	const from = L(
		"    if (req.method.toLowerCase() === 'head') {",
		"        res.status(200);",
		"        res.setHeader('Accept-Ranges', 'bytes');",
		"        res.setHeader('Content-Length', stat.size);",
		"        return res.end();",
		"    }",
	);
	writeOverlay("GHSA-rv78-qqrq-73m5", pin, [
		{
			file: "controllers/assets.js",
			replace: [
				{
					from,
					to: from.replace(
						"        res.status(200);",
						L("        if (typeof stream?.destroy === 'function')", "            stream.destroy();", "        res.status(200);"),
					),
				},
			],
		},
	]);
});

// --- GHSA-fm3h-p9wm-h74h: failed condition returns the raw Joi error, including the whole payload ---
writeOverlay("GHSA-fm3h-p9wm-h74h", "10.13.4", [
	{
		file: "operations/condition/index.js",
		replace: [
			{
				from: "import { defineOperationApi } from '@directus/extensions';",
				to: L(
					"import { defineOperationApi } from '@directus/extensions';",
					"import { FailedValidationError, joiValidationErrorItemToErrorExtensions } from '@directus/validation';",
				),
			},
			{
				from: "            throw errors;",
				to: "            throw errors.flatMap((error) => (error.details ?? []).map((details) => new FailedValidationError(joiValidationErrorItemToErrorExtensions(details))));",
			},
		],
	},
]);
writeOverlay("GHSA-fm3h-p9wm-h74h", "9.26.0", [
	{
		file: "operations/condition/index.js",
		replace: [
			{
				from: "import { defineOperationApi, validatePayload } from '@directus/utils';",
				to: L(
					"import { defineOperationApi, validatePayload } from '@directus/utils';",
					"import { FailedValidationException } from '@directus/exceptions';",
				),
			},
			{
				from: "            throw errors;",
				to: "            throw errors.flatMap((error) => (error.details ?? []).map((details) => new FailedValidationException(details)));",
			},
		],
	},
]);

// --- GHSA-56p6-qw3c-fq2g: session tokens of suspended users stay valid (10.13.4) ---
writeOverlay("GHSA-56p6-qw3c-fq2g", "10.13.4", [
	{
		file: "services/users.js",
		replace: [
			{
				from: L(
					"            (opts || (opts = {})).preMutationError = err;",
					"        }",
					"        return await super.updateMany(keys, data, opts);",
					"    }",
				),
				to: L(
					"            (opts || (opts = {})).preMutationError = err;",
					"        }",
					"        const updatedKeys = await super.updateMany(keys, data, opts);",
					"        if (data['status'] !== undefined && data['status'] !== 'active') {",
					"            await this.knex.from('directus_sessions').whereIn('user', keys).delete();",
					"        }",
					"        return updatedKeys;",
					"    }",
				),
			},
		],
	},
]);

// --- GHSA-pmf4-v838-29hg: non-admins can create a share with any role ---
both((pin, nine) => {
	const forbidden = nine ? "ForbiddenException()" : "ForbiddenError()";
	writeOverlay("GHSA-pmf4-v838-29hg", pin, [
		{
			file: "services/shares.js",
			replace: [
				{
					from: "    async createOne(data, opts) {",
					to: L(
						"    async createOne(data, opts) {",
						"        if (data && data['role'] && this.accountability && this.accountability.admin !== true) {",
						"            const shareRole = data['role']?.id ?? data['role'];",
						"            if (shareRole !== this.accountability.role)",
						`                throw new ${forbidden};`,
						"        }",
					),
				},
			],
		},
	]);
});

// --- GHSA-f24x-rm6g-3w5v / GHSA-x3vm-88hf-gpxp: Log to Console prints request tokens and user secrets ---
// One upstream commit (859f664f5) fixed both. Each overlay redacts its own keys at its own line,
// so either can be applied or rolled back without the other.
function logRedaction(name, keys, redacted) {
	return L(
		"        if (operation.type === 'log') {",
		`            const ${name} = (value, parent) => {`,
		"                if (Array.isArray(value))",
		`                    return value.map((entry) => ${name}(entry, parent));`,
		"                if (value === null || typeof value !== 'object' || value instanceof Date)",
		"                    return value;",
		"                const output = {};",
		"                for (const [key, entry] of Object.entries(value)) {",
		`                    output[key] = (${JSON.stringify(keys).replaceAll('"', "'")}[parent] ?? []).includes(key) ? ${redacted} : ${name}(entry, key);`,
		"                }",
		"                return output;",
		"            };",
		`            keyedData = ${name}(keyedData, null);`,
		"        }",
	);
}
both((pin, nine) => {
	const redacted = nine ? "'--redacted--'" : "getRedactedString(key)";
	const lookup = nine
		? "        const handler = this.operations[operation.type];"
		: "        const handler = this.operations.get(operation.type);";
	const unknown = L(
		"            logger.warn(`Couldn't find operation ${operation.type}`);",
		"            return { successor: null, status: 'unknown', data: null, options: null };",
		"        }",
	);
	writeOverlay("GHSA-f24x-rm6g-3w5v", pin, [
		{
			file: "flows.js",
			replace: [
				{
					from: unknown,
					to: L(
						unknown,
						logRedaction("redactLogRequest", { headers: ["authorization", "cookie"], query: ["access_token"] }, redacted),
					),
				},
			],
		},
	]);
	writeOverlay("GHSA-x3vm-88hf-gpxp", pin, [
		{
			file: "flows.js",
			replace: [
				{
					from: lookup,
					to: L(
						lookup,
						logRedaction(
							"redactLogPayload",
							{ payload: ["password", "token", "tfa_secret", "external_identifier", "auth_data"] },
							redacted,
						),
					),
				},
			],
		},
	]);
});

// ===================== 9.26.0 only (fixed upstream in 10.x) =====================

// --- GHSA-cff8-x7jv-4fm8: SSO callback response is cached and served to the next visitor ---
writeOverlay("GHSA-cff8-x7jv-4fm8", "9.26.0", [
	{
		file: "middleware/respond.js",
		replace: [
			{
				from: L("        env['CACHE_ENABLED'] === true &&", "        cache &&"),
				to: L("        env['CACHE_ENABLED'] === true &&", "        req.originalUrl?.startsWith('/auth') === false &&", "        cache &&"),
			},
		],
	},
]);

// --- GHSA-vw58-ph65-6rxp: ?access_token is not redacted in raw request logs ---
writeOverlay("GHSA-vw58-ph65-6rxp", "9.26.0", [
	{
		file: "logger.js",
		replace: [
			{
				from: "        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers'],",
				to: "        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers', 'req.query.access_token'],",
			},
		],
	},
]);

// --- GHSA-3fff-gqw3-vj86: app-access users can PATCH a preset over to another user ---
writeOverlay("GHSA-3fff-gqw3-vj86", "9.26.0", [
	{
		file: "database/system-data/app-access-permissions/index.js",
		replace: [
			{
				from: "const permissions = requireYAML(path.resolve(__dirname, './app-access-permissions.yaml'));",
				to: L(
					"const permissions = requireYAML(path.resolve(__dirname, './app-access-permissions.yaml'));",
					"for (const row of permissions) {",
					"    if (row.collection === 'directus_presets' && row.action === 'update' && !row.validation)",
					"        row.validation = { user: { _eq: '$CURRENT_USER' } };",
					"}",
				),
			},
		],
	},
]);

// --- GHSA-68g8-c275-xf2m: 127.0.0.0/8 aliases bypass the 0.0.0.0 deny entry ---
writeOverlay("GHSA-68g8-c275-xf2m", "9.26.0", [
	{
		file: "request/validate-ip.js",
		replace: [
			{
				from: L("            for (const info of networkInfo) {", "                if (info.address === ip) {"),
				to: L(
					"            for (const info of networkInfo) {",
					"                if (info.internal && info.family === 'IPv4' && String(info.address).startsWith('127.') && String(ip).startsWith('127.')) {",
					"                    throw new Error(`Requested URL \"${url}\" resolves to a denied IP address`);",
					"                }",
					"                if (info.address === ip) {",
				),
			},
		],
	},
]);

// --- GHSA-8p72-rcq4-h6pw: redirects reach internal IPs (only the final socket was checked) ---
writeOverlay("GHSA-8p72-rcq4-h6pw", "9.26.0", [
	{
		file: "request/index.js",
		replace: [
			{
				from: "        _cache.axiosInstance = axios.create();",
				to: L(
					"        const { Agent: AgentHttp } = await import('node:http');",
					"        const { Agent: AgentHttps } = await import('node:https');",
					"        const { isIP } = await import('node:net');",
					"        const { validateIP } = await import('./validate-ip.js');",
					"        const withIpValidation = (agent) => {",
					"            const { createConnection } = agent;",
					"            agent.createConnection = function (options, oncreate) {",
					"                const host = options.host;",
					"                if (!host)",
					"                    throw new Error('Request cannot be verified due to missing host');",
					"                const socket = createConnection.call(this, options, oncreate);",
					"                const check = (address) => validateIP(address, String(host)).catch((error) => socket.destroy(error));",
					"                if (isIP(host) !== 0)",
					"                    check(host);",
					"                socket.on('lookup', (error, address) => {",
					"                    if (!error)",
					"                        check(address);",
					"                });",
					"                return socket;",
					"            };",
					"            return agent;",
					"        };",
					"        _cache.axiosInstance = axios.create({ httpAgent: withIpValidation(new AgentHttp()), httpsAgent: withIpValidation(new AgentHttps()) });",
				),
			},
		],
	},
]);

// --- GHSA-jgf4-vwc3-r46v: local login says which accounts belong to an SSO provider ---
writeOverlay("GHSA-jgf4-vwc3-r46v", "9.26.0", [
	{
		file: "services/authentication.js",
		replace: [
			{
				from: L(
					"        else if (user.provider !== providerName) {",
					"            await stall(STALL_TIME, timeStart);",
					"            throw new InvalidProviderException();",
					"        }",
				),
				to: L(
					"        else if (user.provider !== providerName) {",
					"            emitStatus('fail');",
					"            await stall(STALL_TIME, timeStart);",
					"            throw new InvalidCredentialsException();",
					"        }",
				),
			},
		],
	},
]);

// --- GHSA-632p-p495-25m5: non-numeric ?length breaks random string generation ---
writeOverlay("GHSA-632p-p495-25m5", "9.26.0", [
	{
		file: "controllers/utils.js",
		replace: [
			{
				from: L(
					"    if (req.query && req.query['length'] && Number(req.query['length']) > 500)",
					"        throw new InvalidQueryException(`\"length\" can't be more than 500 characters`);",
					"    const string = nanoid(req.query?.['length'] ? Number(req.query['length']) : 32);",
				),
				to: L(
					"    const rawLength = req.query?.['length'];",
					"    const length = rawLength === undefined || rawLength === '' ? 32 : Number(rawLength);",
					"    if (!Number.isInteger(length) || length < 1 || length > 500)",
					"        throw new InvalidQueryException(`\"length\" must be an integer between 1 and 500`);",
					"    const string = nanoid(length);",
				),
			},
		],
	},
	{
		file: "services/graphql/index.js",
		replace: [
			{
				from: L(
					"                    if (args['length'] && Number(args['length']) > 500) {",
					"                        throw new InvalidPayloadException(`\"length\" can't be more than 500 characters`);",
				),
				to: L(
					"                    if (args['length'] !== undefined && args['length'] !== null && (!Number.isInteger(args['length']) || args['length'] < 1 || args['length'] > 500)) {",
					"                        throw new InvalidPayloadException(`\"length\" must be between 1 and 500`);",
				),
			},
		],
	},
]);

// --- GHSA-7hmh-pfrp-vcx4: GraphQL documents have no token limit ---
writeOverlay("GHSA-7hmh-pfrp-vcx4", "9.26.0", [
	{
		file: "middleware/graphql.js",
		replace: [
			{
				from: "        document = parse(new Source(query));",
				to: "        document = parse(new Source(query), { maxTokens: Number(process.env['GRAPHQL_QUERY_TOKEN_LIMIT'] ?? 5000) });",
			},
		],
	},
]);

// --- GHSA-p8v3-m643-4xqx: ?alias reads hashed/concealed fields unredacted ---
writeOverlay("GHSA-p8v3-m643-4xqx", "9.26.0", [
	{
		file: "services/payload.js",
		replace: [
			{
				from: L(
					"    async processValues(action, payload) {",
					"        const processedPayload = toArray(payload);",
					"        if (processedPayload.length === 0)",
					"            return [];",
					"        const fieldsInPayload = Object.keys(processedPayload[0]);",
					"        let specialFieldsInCollection = Object.entries(this.schema.collections[this.collection].fields).filter(([_name, field]) => field.special && field.special.length > 0);",
				),
				to: L(
					"    async processValues(action, payload, aliasMap = {}) {",
					"        const processedPayload = toArray(payload);",
					"        if (processedPayload.length === 0)",
					"            return [];",
					"        const fieldsInPayload = Object.keys(processedPayload[0]);",
					"        let specialFieldsInCollection = Object.entries(this.schema.collections[this.collection].fields).filter(([_name, field]) => field.special && field.special.length > 0);",
					"        for (const [aliasName, fieldName] of Object.entries(aliasMap ?? {})) {",
					"            const aliased = specialFieldsInCollection.find(([name]) => name === fieldName);",
					"            if (aliased)",
					"                specialFieldsInCollection.push([aliasName, { ...aliased[1], field: aliasName }]);",
					"        }",
				),
			},
		],
	},
	{
		file: "database/run-ast.js",
		replace: [
			{
				from: "        let items = await payloadService.processValues('read', rawItems);",
				to: "        let items = await payloadService.processValues('read', rawItems, query.alias ?? {});",
			},
		],
	},
]);

// --- GHSA-hxgm-ghmv-xjjm: `_in` against an empty dynamic variable passes validation ---
writeOverlay("GHSA-hxgm-ghmv-xjjm", "9.26.0", [
	{
		file: "utils/get-permissions.js",
		replace: [
			{
				from: L(
					"        permission.permissions = parseFilter(permission.permissions, accountability, filterContext);",
					"        permission.validation = parseFilter(permission.validation, accountability, filterContext);",
				),
				to: L(
					"        const denyEmptyIn = (filter) => {",
					"            if (Array.isArray(filter))",
					"                return filter.map(denyEmptyIn);",
					"            if (filter === null || typeof filter !== 'object')",
					"                return filter;",
					"            const output = {};",
					"            for (const [key, value] of Object.entries(filter)) {",
					"                output[key] = key === '_in' && (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) ? ['__directus_backport_no_match__'] : denyEmptyIn(value);",
					"            }",
					"            return output;",
					"        };",
					"        permission.permissions = parseFilter(permission.permissions, accountability, filterContext);",
					"        permission.validation = denyEmptyIn(parseFilter(permission.validation, accountability, filterContext));",
				),
			},
		],
	},
]);

// --- GHSA-qw9g-7549-7wg5: reset/invite mail goes to the submitted address, not the stored one ---
writeOverlay("GHSA-qw9g-7549-7wg5", "9.26.0", [
	{
		file: "services/users.js",
		replace: [
			{
				from: "            .select('id', 'role', 'status', 'password')",
				to: "            .select('id', 'role', 'status', 'password', 'email')",
			},
			{
				from: L(
					"                    to: email,",
					"                    subject: subjectLine,",
					"                    template: {",
					"                        name: 'user-invitation',",
					"                        data: {",
					"                            url: this.inviteUrl(email, url),",
					"                            email,",
				),
				to: L(
					"                    to: user?.email ?? email,",
					"                    subject: subjectLine,",
					"                    template: {",
					"                        name: 'user-invitation',",
					"                        data: {",
					"                            url: this.inviteUrl(user?.email ?? email, url),",
					"                            email: user?.email ?? email,",
				),
			},
			{
				from: "        const payload = { email, scope: 'password-reset', hash: getSimpleHash('' + user.password) };",
				to: "        const payload = { email: user.email, scope: 'password-reset', hash: getSimpleHash('' + user.password) };",
			},
			{
				from: L(
					"            to: email,",
					"            subject: subjectLine,",
					"            template: {",
					"                name: 'password-reset',",
					"                data: {",
					"                    url: acceptURL,",
					"                    email,",
				),
				to: L(
					"            to: user.email,",
					"            subject: subjectLine,",
					"            template: {",
					"                name: 'password-reset',",
					"                data: {",
					"                    url: acceptURL,",
					"                    email: user.email,",
				),
			},
		],
	},
]);
