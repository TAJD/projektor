// PROJ-510/PROJ-512: decodeURIComponent throws on a malformed percent-escape (e.g. a
// bare "%" not followed by two hex digits). Callers that parse a slug/id out of a raw
// URL path segment want "not decodable" treated as "missing", not a crash.
// Note: this is a local implementation. The same function is defined in apps/api/src/lib/urls.ts
// with identical behavior (both return null on decode failure).
function safeDecodeURIComponent(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

export { safeDecodeURIComponent };
