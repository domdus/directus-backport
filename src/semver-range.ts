import semver from "semver";

/** Turn catalog ranges like `>= 10.13.0, < 12.1.0` into a semver range. */
export function normalizeRange(range: string): string {
	return range
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.join(" ");
}

export function versionSatisfies(version: string, range: string): boolean {
	const coerced = semver.coerce(version);
	if (!coerced) return false;
	const normalized = normalizeRange(range);
	try {
		return semver.satisfies(coerced, normalized, { includePrerelease: true });
	} catch {
		return false;
	}
}

export function isNewerOrEqual(version: string, minimum: string): boolean {
	const left = semver.coerce(version);
	const right = semver.coerce(minimum);
	if (!left || !right) return false;
	return semver.gte(left, right);
}
