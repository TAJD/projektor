import { apiFetch } from "./api-client";

/** Cursor-paged response shape shared by the list endpoints (`/api/issues`, …). */
export interface Page<T> {
	items: T[];
	nextCursor?: string | number | null;
}

type Cursor = NonNullable<Page<unknown>["nextCursor"]>;

/** The API caps a page at 100 rows. */
export const MAX_PAGE_SIZE = 100;

/**
 * Safety valve against a server that never stops returning a cursor. Hitting it is
 * logged, never silent: truncating quietly is exactly the bug this module exists to prevent.
 */
export const MAX_PAGES = 50;

/**
 * Yield pages from `fetchPage` until the server stops returning a `nextCursor`.
 * Prefer this over a hand-rolled loop when a caller wants to render incrementally.
 */
export async function* paginate<T>(
	fetchPage: (cursor: Cursor | null) => Promise<Page<T>>,
	maxPages = MAX_PAGES
): AsyncGenerator<T[], void, undefined> {
	let cursor: Cursor | null = null;
	for (let n = 0; n < maxPages; n++) {
		const page = await fetchPage(cursor);
		yield Array.isArray(page.items) ? page.items : [];
		cursor = page.nextCursor ?? null;
		if (cursor === null) return;
	}
	console.warn(`paginate: stopped after ${maxPages} pages; results are truncated`);
}

/** Collect every page into one flat array. */
export async function fetchAllPages<T>(
	fetchPage: (cursor: Cursor | null) => Promise<Page<T>>,
	maxPages = MAX_PAGES
): Promise<T[]> {
	const all: T[] = [];
	for await (const items of paginate(fetchPage, maxPages)) all.push(...items);
	return all;
}

/**
 * Every issue matching `query` (the same filters `GET /api/issues` accepts), paging at the
 * API's maximum page size. Issue #417: callers that omit this fetched only the first 30.
 */
export function fetchAllIssues<T>(
	query: URLSearchParams | Record<string, string>,
	workspaceSlug: string | undefined
): Promise<T[]> {
	return fetchAllPages<T>((cursor) => {
		const qs = new URLSearchParams(query);
		qs.set("limit", String(MAX_PAGE_SIZE));
		if (cursor !== null) qs.set("cursor", String(cursor));
		return apiFetch<Page<T>>(`/api/issues?${qs}`, { workspaceSlug });
	});
}
