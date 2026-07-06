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

/** Canonical web UI path for a wiki page (PROJ-307). */
export function wikiPagePath(slug: string, projectId: string | null): string {
	const qs = new URLSearchParams({ slug });
	if (projectId) qs.set("projectId", projectId);
	return `/wiki?${qs.toString()}`;
}
