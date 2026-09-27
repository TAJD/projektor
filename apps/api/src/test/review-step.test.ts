import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0061 from "../../../../packages/db/migrations/0061_task_status_review_step.sql?raw";
import {
	authHeaders,
	seedAgentLease,
	seedIssue,
	seedProjectFixture,
	seedTaskStatus,
} from "./helpers";

// PROJ-749: a status is a review step because the workspace flagged it
// (task_statuses.is_review_step), not because its key contains "review".
describe("PROJ-749: review steps are explicit, not inferred from the status key", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	function patch(id: string, body: Record<string, unknown>) {
		return SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	async function reviewState(id: string) {
		const row = await env.DB.prepare(
			"SELECT in_review_at, review_bounce_count FROM issues WHERE id = ?"
		)
			.bind(id)
			.first<{ in_review_at: number | null; review_bounce_count: number }>();
		const rejections = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM issue_gate_rejections WHERE issue_id = ?"
		)
			.bind(id)
			.first<{ n: number }>();
		return { ...row, gateRejections: rejections?.n ?? 0 };
	}

	it('a "Contract Review" status that is not a review step is not gated and not counted', async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Contract" });
		await seedAgentLease(workspaceId, issue.id);
		const contract = await seedTaskStatus(workspaceId, {
			key: "contract_review",
			name: "Contract Review",
			category: "in_progress",
		});

		// No completion report needed: it isn't a review step.
		expect((await patch(issue.id, { statusId: contract.id })).status).toBe(200);
		// Leaving it for in_progress is not a review bounce / gate rejection.
		expect((await patch(issue.id, { status: "in_progress" })).status).toBe(200);

		expect(await reviewState(issue.id)).toEqual({
			in_review_at: null,
			review_bounce_count: 0,
			gateRejections: 0,
		});
	});

	it("a custom status flagged as a review step is gated, stamped and counted", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Peer" });
		await seedAgentLease(workspaceId, issue.id);
		const peer = await seedTaskStatus(workspaceId, {
			key: "peer_review",
			name: "Peer Review",
			category: "in_progress",
			isReviewStep: true,
		});

		expect((await patch(issue.id, { statusId: peer.id })).status).toBe(400);
		expect(
			(
				await patch(issue.id, {
					statusId: peer.id,
					completionReport: { summary: "s", verification: "v" },
				})
			).status
		).toBe(200);
		expect((await patch(issue.id, { status: "in_progress" })).status).toBe(200);

		const state = await reviewState(issue.id);
		expect(state.in_review_at).not.toBeNull();
		expect(state.review_bounce_count).toBe(1);
		expect(state.gateRejections).toBe(1);
	});

	it("create/update_task_status set and clear the flag (REST)", async () => {
		const created = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				key: "design_review",
				name: "Design Review",
				category: "in_progress",
				isReviewStep: true,
			}),
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const flag = async () =>
			(
				await env.DB.prepare("SELECT is_review_step AS f FROM task_statuses WHERE id = ?")
					.bind(id)
					.first<{ f: number }>()
			)?.f;
		expect(await flag()).toBe(1);

		const updated = await SELF.fetch(`http://localhost/api/task-statuses/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ isReviewStep: false }),
		});
		expect(updated.status).toBe(200);
		expect(await flag()).toBe(0);
	});
});

describe("PROJ-749: migration 0061 backfill preserves today's behaviour", () => {
	it("flags every existing status whose key contains 'review', and nothing else", async () => {
		const ws = `ws-${crypto.randomUUID().slice(0, 8)}`;
		await env.DB.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, 0)")
			.bind(ws, ws, ws)
			.run();
		const keys = ["in_review", "code_review", "contract_review", "todo", "done"];
		for (const key of keys) {
			await env.DB.prepare(
				"INSERT INTO task_statuses (id, workspace_id, key, name, category, position, is_default, is_review_step) VALUES (?, ?, ?, ?, 'todo', 0, 0, 0)"
			)
				.bind(crypto.randomUUID(), ws, key, key)
				.run();
		}
		const backfill = m0061
			.replace(/--[^\n]*/g, "")
			.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("UPDATE"));
		expect(backfill).toBeDefined();
		await env.DB.prepare(backfill as string).run();

		const rows = await env.DB.prepare(
			"SELECT key, is_review_step AS f FROM task_statuses WHERE workspace_id = ? ORDER BY key"
		)
			.bind(ws)
			.all<{ key: string; f: number }>();
		expect(Object.fromEntries(rows.results.map((r) => [r.key, r.f]))).toEqual({
			code_review: 1,
			contract_review: 1,
			done: 0,
			in_review: 1,
			todo: 0,
		});
	});
});
