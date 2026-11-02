#!/usr/bin/env node
/**
 * Exercise a running Directus and print one line per check. Run it before and
 * after patching, then diff the two outputs: a change is a regression to explain.
 * It writes only a temporary folder, which it deletes again.
 *
 *   node scripts/smoke.mjs http://localhost:8055 admin@example.com secret
 */
const [base, email, password] = process.argv.slice(2);
if (!password) {
	console.error("usage: smoke.mjs <url> <admin-email> <admin-password>");
	process.exit(2);
}

let token = "";
const lines = [];

async function call(method, path, body, auth = true) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			...(auth && token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, text };
}

function record(label, result, detail = "") {
	lines.push(`${String(result.status).padEnd(4)} ${label}${detail ? `  ${detail}` : ""}`);
}

const errorOf = (result) => result.json?.errors?.[0]?.message ?? "";

const login = await call("POST", "/auth/login", { email, password }, false);
record("POST /auth/login", login);
token = login.json?.data?.access_token ?? "";
if (!token) {
	console.log(lines.join("\n"));
	process.exit(1);
}

const refresh = await call("POST", "/auth/refresh", { refresh_token: login.json.data.refresh_token, mode: "json" }, false);
record("POST /auth/refresh", refresh);
token = refresh.json?.data?.access_token ?? token;

for (const path of [
	"/server/ping",
	"/server/info",
	"/users/me",
	"/users?limit=1",
	"/roles?limit=1",
	"/collections",
	"/fields/directus_users",
	"/relations",
	"/settings",
	"/files?limit=1",
	"/folders?limit=1",
	"/activity?limit=1",
	"/revisions?limit=1",
	"/presets?limit=1",
	"/flows?limit=1",
	"/operations?limit=1",
	"/dashboards?limit=1",
	"/panels?limit=1",
	"/notifications?limit=1",
	"/shares?limit=1",
	"/permissions?limit=1",
	"/permissions/me",
	"/policies?limit=1",
	"/extensions",
	"/schema/snapshot",
	"/utils/random/string",
	"/users?filter[email][_eq]=nobody@example.invalid",
	"/users?aggregate[count]=*",
	"/roles?fields=users.id&deep[users][_limit]=1",
	"/roles?fields=users.role.users.id&deep[users][role][users][_limit]=1",
]) {
	const result = await call("GET", path);
	record(`GET ${path}`, result, result.status >= 400 ? errorOf(result) : "");
}

const anon = await call("GET", "/users?limit=1", undefined, false);
record("GET /users anonymous", anon);

const graphql = async (path, query, label) => {
	const result = await call("POST", path, { query });
	const errors = result.json?.errors?.map((item) => item.message).join("; ") ?? "";
	record(label, result, errors);
};
await graphql("/graphql/system", "{ server_ping }", "GRAPHQL system query");
await graphql("/graphql/system", "{ users_me { id } }", "GRAPHQL users_me");
await graphql("/graphql/system", "{ __schema { queryType { name } } }", "GRAPHQL introspection");
await graphql("/graphql", "{ __typename }", "GRAPHQL items query");
await graphql(
	"/graphql/system",
	'mutation { a: auth_password_request(email: "x@example.invalid") b: auth_password_request(email: "y@example.invalid") }',
	"GRAPHQL repeated mutation",
);
await graphql(
	"/graphql/system",
	'mutation { ...F ...F } fragment F on Mutation { auth_password_request(email: "x@example.invalid") }',
	"GRAPHQL repeated fragment",
);

const created = await call("POST", "/folders", { name: `smoke-${Date.now()}` });
record("POST /folders", created, created.status >= 400 ? errorOf(created) : "");
const id = created.json?.data?.id;
if (id) {
	record("PATCH /folders/:id", await call("PATCH", `/folders/${id}`, { name: "smoke-renamed" }));
	record("GET /folders/:id", await call("GET", `/folders/${id}`));
	record("DELETE /folders/:id", await call("DELETE", `/folders/${id}`));
}

const upload = new FormData();
upload.append("title", "smoke");
upload.append("file", new Blob(["smoke\n"], { type: "text/plain" }), "smoke.txt");
const file = await fetch(`${base}/files`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: upload });
const fileJson = await file.json().catch(() => null);
record("POST /files upload", { status: file.status }, file.status >= 400 ? fileJson?.errors?.[0]?.message : "");
if (fileJson?.data?.id) {
	record("GET /assets/:id", await call("GET", `/assets/${fileJson.data.id}`));
	record("DELETE /files/:id", await call("DELETE", `/files/${fileJson.data.id}`));
}

record("POST /auth/logout", await call("POST", "/auth/logout", { refresh_token: refresh.json?.data?.refresh_token, mode: "json" }));
console.log(lines.join("\n"));
