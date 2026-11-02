import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.sig";

const SIGNABLE = /\.(yml|yaml|md|patch|txt)$/i;

/**
 * Ed25519 public keys (base64 SPKI DER) allowed to sign a downloaded catalog.
 * The GitHub repo alone is not enough to reach a host: a patch is code that runs
 * inside Directus, so it needs a signature from a key that never lives on GitHub.
 * List two keys while rotating.
 */
export const TRUSTED_KEYS: string[] = ["MCowBQYDK2VwAyEAkAnAGLVNWp9fENhj6PRaJ+8R8K2JeZAo71x2j0pQptk="];

export type CatalogManifest = {
	manifest_version: 1;
	/** Grows with every signed release, so an old signed catalog cannot be replayed. */
	sequence: number;
	files: Record<string, string>;
};

export type CatalogTrust = { sequence: number; key: string };

/** `source.yml` chooses where updates come from, so a catalog may never carry its own. */
export function isSignableCatalogFile(rel: string): boolean {
	return SIGNABLE.test(rel) && rel !== "source.yml";
}

function trustedKeys(): string[] {
	const extra = (process.env.DIRECTUS_BACKPORT_TRUSTED_KEY || "").trim();
	return extra ? [...TRUSTED_KEYS, extra] : TRUSTED_KEYS;
}

function keyId(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function walk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

/** The catalog files a signature covers. */
export function catalogFiles(dir: string): string[] {
	return walk(dir).filter(isSignableCatalogFile).sort();
}

export function buildManifest(dir: string, sequence: number): CatalogManifest {
	const files: Record<string, string> = {};
	for (const rel of catalogFiles(dir)) {
		files[rel] = createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
	}
	return { manifest_version: 1, sequence, files };
}

/** Throws unless `dir` is exactly what a trusted key signed. */
export function verifyCatalogDir(dir: string): CatalogTrust {
	const manifestPath = path.join(dir, MANIFEST_FILE);
	const signaturePath = path.join(dir, SIGNATURE_FILE);
	if (!fs.existsSync(manifestPath) || !fs.existsSync(signaturePath)) {
		throw new Error("Catalog is not signed. Refusing to use it.");
	}
	const manifestBytes = fs.readFileSync(manifestPath);
	const signature = Buffer.from(fs.readFileSync(signaturePath, "utf8").trim(), "base64");
	const key = trustedKeys().find((candidate) => {
		try {
			const publicKey = createPublicKey({
				key: Buffer.from(candidate, "base64"),
				format: "der",
				type: "spki",
			});
			return verify(null, manifestBytes, publicKey, signature);
		} catch {
			return false;
		}
	});
	if (!key) throw new Error("Catalog signature does not match a trusted key. Refusing to use it.");

	const manifest = JSON.parse(manifestBytes.toString("utf8")) as CatalogManifest;
	const listed = Object.keys(manifest.files ?? {}).sort();
	const present = catalogFiles(dir);
	if (listed.join("\n") !== present.join("\n")) {
		throw new Error("Catalog files do not match its signed manifest. Refusing to use it.");
	}
	for (const rel of listed) {
		const actual = createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
		if (actual !== manifest.files[rel]) {
			throw new Error(`Catalog file changed after signing: ${rel}. Refusing to use it.`);
		}
	}
	if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) {
		throw new Error("Catalog manifest has no valid sequence. Refusing to use it.");
	}
	return { sequence: manifest.sequence, key: keyId(key) };
}

/** Sequence of a catalog already on disk, or 0. Never trusted for anything but ordering. */
export function cachedSequence(dir: string): number {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as CatalogManifest;
		return Number.isSafeInteger(manifest.sequence) ? manifest.sequence : 0;
	} catch {
		return 0;
	}
}
