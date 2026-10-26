import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllIssues, fetchAllPages, MAX_PAGE_SIZE, type Page, paginate } from "./paginate";

/** A fetchPage stub that serves `pages` in order, using the page index as the cursor. */
function servePages<T>(pages: T[][]) {
	return vi.fn(async (cursor: string | number | null): Promise<Page<T>> => {
		const index = cursor === null ? 0 : Number(cursor);
		return {
			items: pages[index] ?? [],
			nextCursor: index + 1 < pages.length ? index + 1 : null,
		};
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("paginate / fetchAllPages", () => {
	it("yields each page in order and passes the previous cursor", async () => {
		const fetchPage = servePages([[1, 2], [3], [4]]);
		const seen: number[][] = [];
		for await (const items of paginate(fetchPage)) seen.push(items);

		expect(seen).toEqual([[1, 2], [3], [4]]);
		expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 1, 2]);
	});

	it("flattens every page", async () => {
		expect(await fetchAllPages(servePages([[1, 2], [3], [4, 5]]))).toEqual([1, 2, 3, 4, 5]);
	});

	it("makes one request when there is no nextCursor", async () => {
		const fetchPage = servePages([[1]]);
		expect(await fetchAllPages(fetchPage)).toEqual([1]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("treats a missing items array as an empty page", async () => {
		const fetchPage = vi.fn(async () => ({}) as Page<number>);
		expect(await fetchAllPages(fetchPage)).toEqual([]);
	});

	it("accepts both numeric and string cursors", async () => {
		const fetchPage = vi
			.fn<(cursor: string | number | null) => Promise<Page<number>>>()
			.mockResolvedValueOnce({ items: [1], nextCursor: "1700000000:abc" })
			.mockResolvedValueOnce({ items: [2], nextCursor: 42 })
			.mockResolvedValueOnce({ items: [3], nextCursor: null });
		await fetchAllPages(fetchPage);
		expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, "1700000000:abc", 42]);
	});

	it("stops at maxPages and warns instead of truncating silently", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const endless = vi.fn(async (): Promise<Page<number>> => ({ items: [1], nextCursor: "more" }));

		expect(await fetchAllPages(endless, 3)).toEqual([1, 1, 1]);
		expect(endless).toHaveBeenCalledTimes(3);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("propagates a failure from a later page", async () => {
		const fetchPage = vi
			.fn<(cursor: string | number | null) => Promise<Page<number>>>()
			.mockResolvedValueOnce({ items: [1], nextCursor: "n" })
			.mockRejectedValueOnce(new Error("boom"));
		await expect(fetchAllPages(fetchPage)).rejects.toThrow("boom");
	});
});

describe("fetchAllIssues", () => {
	function stubIssuesApi(total: number, pageSize = MAX_PAGE_SIZE) {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = new URL(input, "http://localhost");
				urls.push(url);
				const start = Number(url.searchParams.get("cursor") ?? 0);
				const end = Math.min(start + pageSize, total);
				const items = Array.from({ length: end - start }, (_, i) => ({ id: `i${start + i}` }));
				return {
					ok: true,
					json: async () => ({ items, nextCursor: end < total ? String(end) : null }),
				};
			})
		);
		return urls;
	}

	it("pages at the API maximum and returns everything (#417: 160 assigned issues)", async () => {
		const urls = stubIssuesApi(160);
		const issues = await fetchAllIssues<{ id: string }>({ assignee: "me" }, undefined);

		expect(issues).toHaveLength(160);
		expect(urls).toHaveLength(2);
		for (const url of urls) {
			expect(url.pathname).toBe("/api/issues");
			expect(url.searchParams.get("limit")).toBe(String(MAX_PAGE_SIZE));
			expect(url.searchParams.get("assignee")).toBe("me");
		}
		expect(urls[0].searchParams.has("cursor")).toBe(false);
		expect(urls[1].searchParams.get("cursor")).toBe("100");
	});

	it("accepts URLSearchParams and does not mutate the caller's copy", async () => {
		const urls = stubIssuesApi(1);
		const query = new URLSearchParams({ parentId: "p1" });
		await fetchAllIssues(query, undefined);

		expect(urls[0].searchParams.get("parentId")).toBe("p1");
		expect(query.toString()).toBe("parentId=p1");
	});

	it("overrides a caller-supplied limit with the maximum page size", async () => {
		const urls = stubIssuesApi(1);
		await fetchAllIssues({ limit: "30" }, undefined);
		expect(urls[0].searchParams.get("limit")).toBe(String(MAX_PAGE_SIZE));
	});
});
