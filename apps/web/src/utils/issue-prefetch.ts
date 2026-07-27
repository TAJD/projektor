/**
 * Handoff between the inline `<script>` in issues/view.astro and the IssueDetail island.
 *
 * PROJ-438: nothing reached the API until ~445 ms on a mobile profile, because the first
 * request was issued by an effect that can't run until the island's module graph has
 * downloaded, parsed and hydrated. The inline script has none of that in front of it, so
 * it starts the request during HTML parse and parks the promise here.
 */

const HANDOFF = "__projektorIssuePrefetch";

export interface IssuePrefetchHandoff {
	/** Ref ("PROJ-42") or UUID the request was issued for. */
	key: string;
	/** When the request was issued, for the freshness bound below. */
	t: number;
	/** Resolves to null if the request itself failed — never rejects. */
	response: Promise<Response | null>;
}

/**
 * A handoff only ever has to bridge HTML parse to island hydration — a few hundred
 * milliseconds, ~2.4s on a throttled mobile profile. Past this it is treated as absent.
 *
 * It needs a bound because an unclaimed handoff survives for the life of the tab:
 * ClientRouter replaces the body, not the window. Navigate to an issue, leave before the
 * island's chunk hydrates, come back much later, and without this the page would render
 * that stale payload — and, since a seeded issue skips the refetch, never correct it. The
 * listener in issues/view.astro clears the handoff on swap too; this is the backstop for
 * when that hasn't run.
 */
const MAX_HANDOFF_AGE_MS = 15_000;

/**
 * Claim the prefetched response for `key`, or null if there isn't a fresh one.
 *
 * Single-use: a claimed handoff is removed, so a client-side navigation to another issue
 * can't be served the previous one's payload. Rejects (rather than returning null) if the
 * prefetch failed or returned a non-2xx — the caller falls back to `apiFetch`, which owns
 * the 401/re-auth handling this deliberately does not replicate.
 */
export function claimPrefetchedIssue<T>(key: string): Promise<T> | null {
	const w = window as unknown as Record<string, IssuePrefetchHandoff | undefined>;
	const handoff = w[HANDOFF];
	if (!handoff || handoff.key !== key) return null;
	delete w[HANDOFF];
	if (!(Date.now() - handoff.t < MAX_HANDOFF_AGE_MS)) return null;

	return handoff.response.then((res) => {
		if (!res?.ok) throw new Error("issue prefetch missed");
		return res.json() as Promise<T>;
	});
}
