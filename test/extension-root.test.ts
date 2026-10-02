import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

describe("extension package root on non-/directus installs", () => {
	it("finds the extension under /opt/node/directus/extensions/…", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "directus-backport-opt-"));
		const directusRoot = path.join(tmp, "opt", "node", "directus");
		const ext = path.join(directusRoot, "extensions", "directus-extension-backport");
		const dist = path.join(ext, "dist");
		fs.mkdirSync(dist, { recursive: true });
		fs.mkdirSync(path.join(directusRoot, "node_modules", "directus"), { recursive: true });
		fs.writeFileSync(
			path.join(directusRoot, "node_modules", "directus", "package.json"),
			JSON.stringify({ name: "directus", version: "11.17.4" }),
		);
		fs.writeFileSync(
			path.join(ext, "package.json"),
			JSON.stringify({ name: "directus-extension-backport", version: "1.0.0" }),
		);
		fs.writeFileSync(path.join(dist, "api.js"), "export default {}\n");
		fs.writeFileSync(path.join(dist, "cli.mjs"), "// cli\n");
		fs.writeFileSync(path.join(dist, "rollback.mjs"), "// rollback\n");

		const prevRoot = process.env.DIRECTUS_BACKPORT_ROOT;
		const prevExt = process.env.DIRECTUS_BACKPORT_EXTENSION;
		try {
			delete process.env.DIRECTUS_BACKPORT_EXTENSION;
			process.env.DIRECTUS_BACKPORT_ROOT = directusRoot;

			// Import after env is set; simulate api.js living in dist/
			const runtimeUrl = pathToFileURL(
				path.resolve("directus-extension-backport/src/shared/runtime.ts"),
			).href;
			const { extensionPackageRoot } = await import(`${runtimeUrl}?t=${Date.now()}`);
			const found = extensionPackageRoot(dist);
			assert.equal(found, ext);
			assert.ok(fs.existsSync(path.join(found, "dist", "cli.mjs")));
		} finally {
			if (prevRoot === undefined) delete process.env.DIRECTUS_BACKPORT_ROOT;
			else process.env.DIRECTUS_BACKPORT_ROOT = prevRoot;
			if (prevExt === undefined) delete process.env.DIRECTUS_BACKPORT_EXTENSION;
			else process.env.DIRECTUS_BACKPORT_EXTENSION = prevExt;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
