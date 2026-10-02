import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const ALLOWED = /\.(yml|yaml|md|patch|txt)$/i;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

function octal(buf: Buffer, start: number, length: number): number {
	const raw = buf.toString("utf8", start, start + length).replace(/\0.*$/, "").trim();
	if (!raw) return 0;
	return Number.parseInt(raw, 8);
}

function cString(buf: Buffer, start: number, length: number): string {
	return buf.toString("utf8", start, start + length).replace(/\0.*$/, "");
}

/** Map a tarball path to a file under catalog/, or null to skip. */
export function catalogRelFromTarPath(entry: string): string | null {
	const parts = entry.replaceAll("\\", "/").split("/").filter(Boolean);
	if (parts.includes("..") || parts.includes("")) return null;
	const idx = parts.indexOf("catalog");
	if (idx < 0) return null;
	const rest = parts.slice(idx + 1);
	if (rest.length === 0) return null;
	const file = rest.join("/");
	if (!ALLOWED.test(file)) return null;
	return file;
}

/**
 * Extract `catalog/**` from a GitHub-style gzip tarball into dest (the catalog root).
 */
export function extractCatalogTarGz(archive: Buffer, dest: string): { files: string[] } {
	const unzipped = gunzipSync(archive);
	const files: string[] = [];
	let offset = 0;
	let total = 0;
	let pendingLongName: string | null = null;

	while (offset + 512 <= unzipped.length) {
		const header = unzipped.subarray(offset, offset + 512);
		offset += 512;
		if (header.every((byte) => byte === 0)) break;

		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 0);
		let name = cString(header, 0, 100);
		const prefix = cString(header, 345, 155);
		if (prefix) name = `${prefix}/${name}`;
		if (pendingLongName) {
			name = pendingLongName;
			pendingLongName = null;
		}

		const dataEnd = offset + size;
		if (dataEnd > unzipped.length) throw new Error("Truncated tar archive");
		const payload = unzipped.subarray(offset, dataEnd);
		offset = Math.ceil(dataEnd / 512) * 512;

		if (type === "L") {
			pendingLongName = payload.toString("utf8").replace(/\0.*$/, "");
			continue;
		}
		if (type !== "0" && type !== "\0" && type !== "") continue;
		if (size > MAX_FILE) throw new Error(`Catalog file too large: ${name}`);
		total += size;
		if (total > MAX_TOTAL) throw new Error("Catalog archive is larger than 20MB");

		const rel = catalogRelFromTarPath(name);
		if (!rel) continue;
		const out = path.join(dest, rel);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, payload);
		files.push(rel);
	}

	if (!files.includes("advisories.yml")) {
		throw new Error("Archive has no catalog/advisories.yml");
	}
	return { files: files.sort() };
}
