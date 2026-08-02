// PROJ-489 (R7): freshness is a derived/computed property, not a stored column — it
// depends on "now" at read time, so the same page can flip from fresh to stale between
// two reads with no write happening in between. This is intentionally a pure function
// (no ctx/db) so it's trivially unit-testable and reusable verbatim across every surface
// that needs it: search ranking + result serialization (services/wiki.ts#searchWiki),
// the page-detail response (services/wiki.ts#getWikiPage, for the UI header), and
// list_stale_pages' filter logic mirrors the same rule in SQL (kept in lockstep by hand,
// see services/wiki.ts#staleWikiPageCondition).

export type WikiFreshnessState = "fresh" | "stale" | "unverified";

export interface WikiFreshness {
	state: WikiFreshnessState;
	// Unix seconds the page became (or would become) stale — the verify_interval due
	// date, when that's what drove the "stale" state. null when staleness came from an
	// explicit status (no time-based due date to report) or the state isn't "stale".
	staleSince: number | null;
}

export interface ComputeFreshnessInput {
	verifiedAt: number | null;
	verifyInterval: number | null;
	status: string | null;
	// Unix seconds; defaults to the real current time. Overridable for tests.
	now?: number;
}

const SECONDS_PER_DAY = 86400;

// PROJ-489: null means the page carries neither frontmatter signal (no verify_interval,
// no status) at all — never fabricate a freshness state for a page that never opted
// into verification tracking. This mirrors the "field present but null, never
// fabricated" convention the pre-R7 placeholder in wiki.test.ts established for the
// `freshness` response field, which this function's return value now serializes into
// directly (`freshness: computeFreshness(...)`).
function computeDueAt(verifiedAt: number | null, verifyInterval: number | null): number | null {
	if (verifyInterval === null || verifiedAt === null) return null;
	return verifiedAt + verifyInterval * SECONDS_PER_DAY;
}

// A verify_interval/verifiedAt due date reached-or-passed, once there's no explicit
// status override (see computeFreshness) and the page has been verified at least once.
function computeTimeBasedFreshness(dueAt: number | null, now: number): WikiFreshness {
	if (dueAt !== null && dueAt <= now) return { state: "stale", staleSince: dueAt };
	return { state: "fresh", staleSince: null };
}

export function computeFreshness(input: ComputeFreshnessInput): WikiFreshness | null {
	const { verifiedAt, verifyInterval, status } = input;
	const hasSignal = status !== null || verifyInterval !== null;
	if (!hasSignal) return null;

	const now = input.now ?? Math.floor(Date.now() / 1000);
	const dueAt = computeDueAt(verifiedAt, verifyInterval);

	// PRD R7: "status: stale/deprecated" is an independent, explicit staleness signal —
	// it wins outright regardless of whether a verify_interval due date has technically
	// been reached yet (a page can be manually flagged stale/deprecated ahead of its
	// scheduled re-verification).
	if (status === "stale" || status === "deprecated") {
		return { state: "stale", staleSince: dueAt !== null && dueAt <= now ? dueAt : null };
	}

	// A verify_interval was declared but the page has never been verified at all —
	// distinct from "verified, but overdue" (below).
	if (verifyInterval !== null && verifiedAt === null) {
		return { state: "unverified", staleSince: null };
	}

	return computeTimeBasedFreshness(dueAt, now);
}
