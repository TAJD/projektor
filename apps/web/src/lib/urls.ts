// PROJ-510/PROJ-512: decodeURIComponent throws on a malformed percent-escape (e.g. a
// bare "%" not followed by two hex digits). Callers that parse a slug/id out of a raw
// URL path segment want "not decodable" treated as "missing", not a crash.
export function safeDecodeURIComponent(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return "";
	}
}
