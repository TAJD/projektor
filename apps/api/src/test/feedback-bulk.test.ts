import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture } from "./helpers";

async function mintSource(
	f: { projectId: string; token: string; slug: string },
	body: Record<string, unknown> = { name: "Widget" }
): Promise<void> {
	await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify(body),
	});
}

async function seedFeedbackRow(
	sourceId: string,
	workspaceId: string,
	projectId: string,
	opts: {
		rating?: number;
		ratingScale?: string;
		body?: string;
		submitterLabel?: string;
		status?: string;
		linkedIssueId?: string;
	} = {}
): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO feedback
       (id, source_id, workspace_id, project_id, rating, rating_scale, body, submitter_label, status, linked_issue_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			sourceId,
			workspaceId,
			projectId,
			opts.rating ?? null,
			opts.ratingScale ?? null,
			opts.body ?? null,
			opts.submitterLabel ?? null,
			opts.status ?? "new",
			opts.linkedIssueId ?? null,
			100
		)
		.run();
	return id;
}

async function firstSourceId(projectId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
		.bind(projectId)
		.first<{ id: string }>();
	return row!.id;
}

describe("POST /api/projects/:id/feedback/bulk-mark-reviewed", () => {
	it("marks all selected rows reviewed regardless of starting status", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId, { status: "new" });
		const id2 = await seedFeedbackRow(src, f.workspaceId, f.projectId, { status: "actioned" });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, id2] }),
			}
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: 2 });

		const rows = await env.DB.prepare("SELECT status FROM feedback WHERE id IN (?, ?)")
			.bind(id1, id2)
			.all<{ status: string }>();
		expect(rows.results.every((r) => r.status === "reviewed")).toBe(true);
	});

	it("ignores feedbackIds from another project", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const other = await seedProjectFixture({ role: "owner" });
		await mintSource(other);
		const otherSrc = await firstSourceId(other.projectId);
		const foreignId = await seedFeedbackRow(otherSrc, other.workspaceId, other.projectId);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [foreignId] }),
			}
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: 0 });

		const row = await env.DB.prepare("SELECT status FROM feedback WHERE id = ?")
			.bind(foreignId)
			.first<{ status: string }>();
		expect(row!.status).toBe("new");
	});

	it("403s for a viewer", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: ["nonexistent"] }),
			}
		);
		expect(res.status).toBe(403);
	});
});

describe("POST /api/projects/:id/feedback/bulk-convert-to-issue", () => {
	it("creates one combined issue and links all selected rows", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			rating: 1,
			ratingScale: "thumbs",
			body: "Love it",
			submitterLabel: "a@b.com",
		});
		const id2 = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			rating: -1,
			ratingScale: "thumbs",
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, id2] }),
			}
		);
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string; convertedCount: number };
		expect(created.convertedCount).toBe(2);

		const rows = await env.DB.prepare(
			"SELECT linked_issue_id, status FROM feedback WHERE id IN (?, ?)"
		)
			.bind(id1, id2)
			.all<{ linked_issue_id: string; status: string }>();
		expect(rows.results).toHaveLength(2);
		for (const row of rows.results) {
			expect(row.linked_issue_id).toBe(created.id);
			expect(row.status).toBe("actioned");
		}

		const issue = await env.DB.prepare("SELECT title, body FROM issues WHERE id = ?")
			.bind(created.id)
			.first<{ title: string; body: string }>();
		expect(issue!.title).toBe("2 feedback items");
		expect(issue!.body).toContain("Love it");
		expect(issue!.body).toContain("a@b.com");
	});

	it("rejects the whole batch (creates no issue, mutates nothing) if any row is already converted", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const freshId = await seedFeedbackRow(src, f.workspaceId, f.projectId);
		const existingIssue = await seedIssue(f.workspaceId, f.projectId, f.userId);
		const convertedId = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			linkedIssueId: existingIssue.id,
			status: "actioned",
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [freshId, convertedId] }),
			}
		);
		expect(res.status).toBe(409);

		const fresh = await env.DB.prepare("SELECT linked_issue_id, status FROM feedback WHERE id = ?")
			.bind(freshId)
			.first<{ linked_issue_id: string | null; status: string }>();
		expect(fresh!.linked_issue_id).toBeNull();
		expect(fresh!.status).toBe("new");
	});

	it("404s if a feedbackId doesn't belong to the project", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, "nonexistent-id"] }),
			}
		);
		expect(res.status).toBe(404);
	});

	it("403s for a viewer", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: ["nonexistent"] }),
			}
		);
		expect(res.status).toBe(403);
	});
});
