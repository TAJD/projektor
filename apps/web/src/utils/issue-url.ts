import { slugify } from "../lib/slugify";

/**
 * Build the canonical pretty URL for an issue.
 * Falls back to the UUID-based URL when projectSlug is unavailable.
 */
export function issueUrl(
	projectSlug: string | null | undefined,
	issueNumber: number,
	title: string,
	fallbackId?: string
): string {
	if (!projectSlug) {
		return fallbackId ? `/issues/view?id=${fallbackId}` : "#";
	}
	return `/projects/${projectSlug}/issues/${issueNumber}/${slugify(title)}`;
}
