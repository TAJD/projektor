import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture } from "./helpers";

describe("Review gating (PROJ-254)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function registerAgent(kind?: "agent" | "human"): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "gate-test", kind }),
		});
		const session = (await res.json()) as { id: string };
		return session.id;
	}

	function patch(id: string, body: Record<string, unknown>) {
		return SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	async function completionReportAtOf(id: string): Promise<number | null> {
		const row = await env.DB.prepare("SELECT completion_report_at FROM issues WHERE id = ?")
			.bind(id)
			.first<{ completion_report_at: number | null }>();
		return row?.completion_report_at ?? null;
	}

	const report = { summary: "Did the thing", verification: "pnpm test" };

	it("rejects an agent entering in_review without a completion report", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "No report" });
		const agentId = await registerAgent();

		const res = await patch(issue.id, { status: "in_review", agentSessionId: agentId });
		expect(res.status).toBe(400);
	});

	it("accepts an agent entering in_review with a completion report, and posts it as a comment", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "With report" });
		const agentId = await registerAgent();

		const res = await patch(issue.id, {
			status: "in_review",
			agentSessionId: agentId,
			completionReport: report,
		});
		expect(res.status).toBe(200);
		expect(await completionReportAtOf(issue.id)).toEqual(expect.any(Number));

		const commentsRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}/comments`, {
			headers: authHeaders(token, slug),
		});
		const comments = (await commentsRes.json()) as Array<{ body: string }>;
		expect(comments.some((c) => c.body.includes("Did the thing"))).toBe(true);
	});

	it("never lets an agent transition an issue to done, report or not", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Agent tries done" });
		const agentId = await registerAgent();

		const res = await patch(issue.id, {
			status: "done",
			agentSessionId: agentId,
			completionReport: report,
		});
		expect(res.status).toBe(403);
	});

	it("blocks a human done transition until a completion report is on record", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Human, no report" });

		const res = await patch(issue.id, { status: "done" });
		expect(res.status).toBe(400);
	});

	it("allows a human done transition once a completion report already exists", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Agent reviewed" });
		const agentId = await registerAgent();

		expect(
			(
				await patch(issue.id, {
					status: "in_review",
					agentSessionId: agentId,
					completionReport: report,
				})
			).status
		).toBe(200);

		const res = await patch(issue.id, { status: "done" });
		expect(res.status).toBe(200);
	});

	it("allows a human to supply the completion report in the same call that marks done", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Straight to done" });

		const res = await patch(issue.id, { status: "done", completionReport: report });
		expect(res.status).toBe(200);
	});

	it("a human-kind agent session is treated as human, not agent", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Human session" });
		const humanSessionId = await registerAgent("human");

		const res = await patch(issue.id, {
			status: "done",
			agentSessionId: humanSessionId,
			completionReport: report,
		});
		expect(res.status).toBe(200);
	});
});
