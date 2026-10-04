import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProject, seedProjectFixture, toolError } from "./helpers";

// PROJ-960: list_issues filters by label; search_issues finds issues by label text and can
// narrow keyword hits by label.

describe("PROJ-960: label filtering", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	async function createIssue(title: string, labels: string[], project = projectId) {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId: project, title, labels }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; number: number };
	}

	async function list(query: string) {
		const res = await SELF.fetch(`http://localhost/api/issues?${query}`, {
			headers: authHeaders(token, slug),
		});
		return {
			status: res.status,
			// biome-ignore lint/suspicious/noExplicitAny: response shape asserted per test
			body: (await res.json()) as any,
		};
	}

	async function search(query: string) {
		const res = await SELF.fetch(`http://localhost/api/issues/search?${query}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as Array<{ id: string; title: string }>;
	}

	async function mcp(name: string, args: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const json = await res.json();
		const err = toolError(json);
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		return { err, data: (text && !err ? JSON.parse(text) : undefined) as any };
	}

	// These tests make more calls per token than wrangler.test.toml's RATE_LIMIT_API_MAX (5).
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	const titles = (items: Array<{ title: string }>) => items.map((i) => i.title).sort();

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
	});

	describe("list_issues", () => {
		beforeEach(async () => {
			await createIssue("bug-a", ["found-in-run", "bug"]);
			await createIssue("bug-b", ["found-in-run"]);
			await createIssue("feature", ["feature", "bug"]);
			await createIssue("plain", []);
		});

		it("returns exactly the labelled issues", async () => {
			const { status, body } = await list("labels=found-in-run");
			expect(status).toBe(200);
			expect(titles(body.items)).toEqual(["bug-a", "bug-b"]);
			expect(body.total).toBe(2);
		});

		it("is all-of by default", async () => {
			const { body } = await list("labels=found-in-run,bug");
			expect(titles(body.items)).toEqual(["bug-a"]);
		});

		it('labelsMode "any" matches at least one', async () => {
			const { body } = await list("labels=found-in-run,feature&labelsMode=any");
			expect(titles(body.items)).toEqual(["bug-a", "bug-b", "feature"]);
		});

		it("matches labels exactly: no substring and no case folding", async () => {
			expect((await list("labels=found-in")).body.items).toHaveLength(0);
			expect((await list("labels=Found-In-Run")).body.items).toHaveLength(0);
			expect((await list("labels=run")).body.items).toHaveLength(0);
		});

		it("an unknown label returns an empty page, not an error", async () => {
			const { status, body } = await list("labels=nope");
			expect(status).toBe(200);
			expect(body.items).toEqual([]);
			expect(body.total).toBe(0);
		});

		it("an empty labels value is no filter", async () => {
			const { body } = await list("labels=");
			expect(body.items).toHaveLength(4);
		});

		it("combines with other filters", async () => {
			const { body } = await list(`labels=bug&project=${projectId}&status=backlog`);
			expect(titles(body.items)).toEqual(["bug-a", "feature"]);
		});

		it("paginates, with the cursor honouring the filter", async () => {
			for (const n of [1, 2, 3, 4, 5]) await createIssue(`cohort-${n}`, ["cohort"]);
			const seen: string[] = [];
			let cursor: string | null = null;
			let pages = 0;
			do {
				const q: string = `labels=cohort&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
				const { body } = await list(q);
				seen.push(...body.items.map((i: { title: string }) => i.title));
				cursor = body.nextCursor;
				pages++;
				expect(pages).toBeLessThan(10);
			} while (cursor);
			expect(pages).toBe(3);
			expect(seen.sort()).toEqual(["cohort-1", "cohort-2", "cohort-3", "cohort-4", "cohort-5"]);
		});

		it("rejects an invalid labelsMode and more than 20 labels", async () => {
			expect((await list("labels=a&labelsMode=some")).status).toBe(400);
			const many = Array.from({ length: 21 }, (_, i) => `l${i}`).join(",");
			expect((await list(`labels=${many}`)).status).toBe(400);
		});

		it("accepts a JSON array over MCP", async () => {
			const { err, data } = await mcp("list_issues", { labels: ["found-in-run"] });
			expect(err).toBeUndefined();
			expect(titles(data.items)).toEqual(["bug-a", "bug-b"]);
			const any = await mcp("list_issues", {
				labels: ["feature", "found-in-run"],
				labelsMode: "any",
			});
			expect(any.data.items).toHaveLength(3);
		});

		it("a row with malformed labels JSON doesn't break the list", async () => {
			const broken = await seedIssue(workspaceId, projectId, userId, { title: "broken-labels" });
			await env.DB.prepare("UPDATE issues SET labels = 'not json' WHERE id = ?")
				.bind(broken.id)
				.run();
			const { status, body } = await list("labels=bug");
			expect(status).toBe(200);
			expect(titles(body.items)).toEqual(["bug-a", "feature"]);
		});

		it("never returns issues from a project the caller can't see", async () => {
			const hidden = await seedProject(workspaceId, "HIDN");
			await createIssue("secret", ["bug"], projectId); // visible control
			const secret = await seedIssue(workspaceId, hidden.id, userId, { title: "hidden-bug" });
			await env.DB.prepare("UPDATE issues SET labels = ? WHERE id = ?")
				.bind(JSON.stringify(["bug"]), secret.id)
				.run();
			const { body } = await list("labels=bug");
			expect(titles(body.items)).toContain("secret");
			expect(titles(body.items)).not.toContain("hidden-bug");
		});
	});

	describe("search_issues", () => {
		beforeEach(async () => {
			await createIssue("Unrelated title one", ["found-in-tech-debt-2026-10"]);
			await createIssue("Unrelated title two", ["found-in-tech-debt-2026-10", "urgent"]);
			await createIssue("Cache invalidation bug", ["cache"]);
			await createIssue("Cache warmup", ["found-in-tech-debt-2026-10"]);
		});

		it("finds issues by exact label text (the reported gap)", async () => {
			const hits = await search("q=found-in-tech-debt-2026-10");
			expect(titles(hits)).toEqual(["Cache warmup", "Unrelated title one", "Unrelated title two"]);
		});

		it("matches the label case-insensitively", async () => {
			const hits = await search("q=FOUND-IN-TECH-DEBT-2026-10");
			expect(hits).toHaveLength(3);
		});

		it("does not substring-match labels", async () => {
			expect(await search("q=tech-debt")).toHaveLength(0);
		});

		it("still finds keyword hits, with no duplicates when a title and a label both match", async () => {
			await createIssue("cache", ["cache"]);
			const hits = await search("q=cache");
			const ids = hits.map((h) => h.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(titles(hits)).toEqual(["Cache invalidation bug", "Cache warmup", "cache"]);
			// Exact-label hits lead the FTS-only hit; their order among themselves is by recency
			// (a same-second tie falls back to id), so only the group boundary is asserted.
			expect(titles(hits.slice(0, 2))).toEqual(["Cache invalidation bug", "cache"]);
			expect(hits[2].title).toBe("Cache warmup");
		});

		it("labels narrows keyword hits", async () => {
			const hits = await search("q=cache&labels=found-in-tech-debt-2026-10");
			expect(titles(hits)).toEqual(["Cache warmup"]);
		});

		it('labelsMode "any" widens the label filter', async () => {
			const hits = await search("q=cache&labels=cache,found-in-tech-debt-2026-10&labelsMode=any");
			expect(titles(hits)).toEqual(["Cache invalidation bug", "Cache warmup"]);
		});

		it("honours limit across both sources", async () => {
			const hits = await search("q=found-in-tech-debt-2026-10&limit=2");
			expect(hits).toHaveLength(2);
		});

		it("accepts a JSON array over MCP", async () => {
			const { err, data } = await mcp("search_issues", {
				query: "cache",
				labels: ["found-in-tech-debt-2026-10"],
			});
			expect(err).toBeUndefined();
			expect(titles(data.items)).toEqual(["Cache warmup"]);
		});

		it("respects project visibility for label-text hits", async () => {
			const hidden = await seedProject(workspaceId, "HIDN");
			const secret = await seedIssue(workspaceId, hidden.id, userId, { title: "hidden" });
			await env.DB.prepare("UPDATE issues SET labels = ? WHERE id = ?")
				.bind(JSON.stringify(["found-in-tech-debt-2026-10"]), secret.id)
				.run();
			const hits = await search("q=found-in-tech-debt-2026-10");
			expect(titles(hits)).toContain("Unrelated title one");
			expect(titles(hits)).not.toContain("hidden");
		});

		it("limit merges label hits and FTS hits: 1 label hit + FTS hits, limit 2", async () => {
			await createIssue("zebra", ["stripes"]);
			await createIssue("Stripes pattern", []);
			await createIssue("Stripes guide", []);
			const hits = await search("q=stripes&limit=2");
			expect(hits).toHaveLength(2);
			expect(hits[0].title).toBe("zebra");
		});

		it("a query longer than 50 chars skips the label branch without error", async () => {
			expect(await search(`q=${"x".repeat(60)}`)).toHaveLength(0);
		});

		it("accepts repeated labels params over REST", async () => {
			const hits = await search(
				"q=cache&labels=cache&labels=found-in-tech-debt-2026-10&labelsMode=any"
			);
			expect(titles(hits)).toEqual(["Cache invalidation bug", "Cache warmup"]);
		});
	});
});
