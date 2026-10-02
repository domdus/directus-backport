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
