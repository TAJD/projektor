// PROJ-857: issue list pagination + query plans.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedIssueFixture } from "./helpers";

describe("PROJ-857: issue list cursor", () => {
	it("pages through 35 issues created in the same second with no gaps or duplicates", async () => {
		const f = await seedIssueFixture();
		// The fixture issue plus 34 more, all stamped with the same created_at.
		const createdAt = Math.floor(Date.now() / 1000);
		for (let n = 2; n <= 35; n++) {
			await env.DB.prepare(
				`INSERT INTO issues (id, workspace_id, project_id, number, title, status, priority, labels, created_by_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'todo', 'none', '[]', ?, ?, ?)`
			)
				.bind(
					crypto.randomUUID(),
					f.workspaceId,
					f.projectId,
					n,
					`same-second ${n}`,
					f.userId,
					createdAt,
					createdAt
				)
				.run();
		}
		await env.DB.prepare("UPDATE issues SET created_at = ? WHERE workspace_id = ?")
			.bind(createdAt, f.workspaceId)
			.run();

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		let firstTotal: number | null = null;
		do {
			const qs = new URLSearchParams({ projectId: f.projectId, limit: "10" });
			if (cursor) qs.set("cursor", cursor);
			const res = await SELF.fetch(`http://localhost/api/issues?${qs}`, {
				headers: authHeaders(f.token, f.slug),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				items: Array<{ id: string }>;
				nextCursor: string | null;
				total: number | null;
			};
			if (pages === 0) firstTotal = body.total;
			else expect(body.total).toBeNull(); // count only on the first page
			seen.push(...body.items.map((i) => i.id));
			cursor = body.nextCursor;
			pages++;
		} while (cursor && pages < 10);

		expect(firstTotal).toBe(35);
		expect(seen).toHaveLength(35);
		expect(new Set(seen).size).toBe(35);
		expect(pages).toBe(4);
	});

	it("still accepts a legacy numeric cursor", async () => {
		const f = await seedIssueFixture();
		const res = await SELF.fetch(
			`http://localhost/api/issues?projectId=${f.projectId}&cursor=${Math.floor(Date.now() / 1000) + 60}`,
			{ headers: authHeaders(f.token, f.slug) }
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
	});
});

describe("PROJ-857: hot queries use an index (no table scan, no temp sort)", () => {
	async function plan(q: string, ...binds: unknown[]): Promise<string> {
		const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q}`)
			.bind(...binds)
			.all<{ detail: string }>();
		return (rows.results ?? []).map((r) => r.detail).join(" | ");
	}

	it.each([
		[
			"project list",
			"SELECT id FROM issues WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT 31",
			["w", "p"],
		],
		[
			"workspace list",
			"SELECT id FROM issues WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 31",
			["w"],
		],
		[
			"issue by ref",
			"SELECT i.id FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.workspace_id = ? AND p.key = ? AND i.number = ?",
			["w", "PROJ", 1],
		],
	])("%s", async (_name, q, binds) => {
		const detail = await plan(q as string, ...(binds as unknown[]));
		expect(detail).not.toMatch(/TEMP B-TREE/);
		expect(detail).not.toMatch(/SCAN (i|issues|p|projects)\b/);
	});
});
