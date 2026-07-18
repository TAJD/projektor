import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedProjectFixture } from "./helpers";

async function mintSource(
	f: { projectId: string; token: string; slug: string },
	body: Record<string, unknown> = { name: "Widget" }
): Promise<string> {
	const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { token: string }).token;
}

async function seedFeedbackRow(
	sourceId: string,
	workspaceId: string,
	projectId: string,
	opts: {
		rating?: number;
		ratingScale?: string;
		body?: string;
		appVersion?: string;
		createdAt?: number;
	} = {}
): Promise<string> {
	const id = crypto.randomUUID();
	const now = opts.createdAt ?? Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO feedback
       (id, source_id, workspace_id, project_id, rating, rating_scale, body, app_version, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
	)
		.bind(
			id,
			sourceId,
			workspaceId,
			projectId,
			opts.rating ?? null,
			opts.ratingScale ?? null,
			opts.body ?? null,
			opts.appVersion ?? null,
			now
		)
		.run();
	return id;
}

describe("GET /api/projects/:id/feedback/summary", () => {
	it("aggregates thumbs %, five-star avg, and comment counts per source+version", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f, { name: "Widget A" });
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();

		// v1.0.0: 2 thumbs up, 1 thumbs down, 1 with a comment
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			rating: 1,
			ratingScale: "thumbs",
			appVersion: "v1.0.0",
			createdAt: 100,
		});
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			rating: 1,
			ratingScale: "thumbs",
			appVersion: "v1.0.0",
			body: "Love it",
			createdAt: 101,
		});
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			rating: -1,
			ratingScale: "thumbs",
			appVersion: "v1.0.0",
			createdAt: 102,
		});
		// v1.1.0 (more recent): 5-star avg of 4.5
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			rating: 4,
			ratingScale: "five_star",
			appVersion: "v1.1.0",
			createdAt: 200,
		});
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			rating: 5,
			ratingScale: "five_star",
			appVersion: "v1.1.0",
			createdAt: 201,
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback/summary`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
		const summary = (await res.json()) as Array<{
			sourceId: string;
			sourceName: string | null;
			totalCount: number;
			versions: Array<{
				appVersion: string | null;
				totalCount: number;
				withCommentCount: number;
				thumbsUpPct: number | null;
				avgFiveStar: number | null;
			}>;
		}>;

		expect(summary).toHaveLength(1);
		expect(summary[0].sourceName).toBe("Widget A");
		expect(summary[0].totalCount).toBe(5);
		expect(summary[0].versions).toHaveLength(2);

		expect(summary[0].versions[0].appVersion).toBe("v1.1.0");
		expect(summary[0].versions[0].avgFiveStar).toBe(4.5);
		expect(summary[0].versions[0].thumbsUpPct).toBeNull();
		expect(summary[0].versions[0].withCommentCount).toBe(0);

		expect(summary[0].versions[1].appVersion).toBe("v1.0.0");
		expect(summary[0].versions[1].thumbsUpPct).toBe(67);
		expect(summary[0].versions[1].avgFiveStar).toBeNull();
		expect(summary[0].versions[1].withCommentCount).toBe(1);
	});

	it("groups rows with a null app_version under a null bucket", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, { body: "no version here" });

		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback/summary`, {
			headers: authHeaders(f.token, f.slug),
		});
		const summary = (await res.json()) as Array<{ versions: Array<{ appVersion: string | null }> }>;
		expect(summary[0].versions[0].appVersion).toBeNull();
	});

	it("404s for a caller with no project access", async () => {
		const owner = await seedProjectFixture({ role: "owner" });
		const stranger = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(
			`http://localhost/api/projects/${owner.projectId}/feedback/summary`,
			{ headers: authHeaders(stranger.token, stranger.slug) }
		);
		expect(res.status).toBe(404);
	});

	it("is readable by a viewer", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback/summary`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
	});

	it("returns an empty array for a project with no feedback", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback/summary`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});
