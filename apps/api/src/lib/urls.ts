function slugifyForUrl(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Canonical web UI path for an issue (PROJ-307). The web app's route only resolves
 * on project key + number — the trailing slug is cosmetic and doesn't need to match
 * exactly, so it's safe to (re)compute here independently of the client.
 */
export function issuePath(projectKey: string, number: number, title: string): string {
	return `/projects/${projectKey}/issues/${number}/${slugifyForUrl(title)}`;
}

/**
 * Canonical web UI path for a wiki page (PROJ-307; path-routed since PROJ-487).
 * Slugs are unique per workspace (PROJ-483), so no project disambiguator is needed.
 */
export function wikiPagePath(slug: string): string {
	return `/wiki/${encodeURIComponent(slug)}`;
}

// PROJ-510/PROJ-512: decodeURIComponent throws on a malformed percent-escape (e.g. a
// bare "%" not followed by two hex digits). Callers that parse a slug out of a raw URL
// or path segment (wiki-links.ts's extractWikiSlugFromUrl, index.ts's SSR fallback)
// want "not decodable" treated as "no slug", not a crash.
export function safeDecodeURIComponent(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}
