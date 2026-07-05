import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedAgentLease,
	seedIssue,
	seedProjectFixture,
	seedTaskStatus,
} from "./helpers";

// PROJ-254 gate, hardened by PROJ-287/289/292/293: the review/done gate is bound to
// the issue's LIVE AGENT LEASE (an agent can't spoof it by omitting agentSessionId or
// self-declaring kind:"human"), the done-report requirement is scoped to agent-worked
// issues, review is keyed on any review-like status, and the report is only stamped on
// a real transition.
// cofferdam-ignore: Readability.MaxFunctionLength: one describe block, normal test style
describe("Review gating (PROJ-254/287/289/292/293)", () => {
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

	async function completionReportAtOf(id: string): Promise<number | null> {
		const row = await env.DB.prepare("SELECT completion_report_at FROM issues WHERE id = ?")
			.bind(id)
			.first<{ completion_report_at: number | null }>();
		return row?.completion_report_at ?? null;
	}

	async function commentBodies(id: string): Promise<string[]> {
		const res = await SELF.fetch(`http://localhost/api/issues/${id}/comments`, {
			headers: authHeaders(token, slug),
		});
		const comments = (await res.json()) as Array<{ body: string }>;
		return comments.map((c) => c.body);
	}

	const report = { summary: "Did the thing", verification: "pnpm test" };

	// --- Agent path (live agent lease present) ---

	it("rejects an agent (live lease) entering in_review without a completion report", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "No report" });
		await seedAgentLease(workspaceId, issue.id);

		const res = await patch(issue.id, { status: "in_review" });
		expect(res.status).toBe(400);
	});

	it("accepts an agent (live lease) entering in_review with a report, and posts it", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "With report" });
		await seedAgentLease(workspaceId, issue.id);

		const res = await patch(issue.id, { status: "in_review", completionReport: report });
		expect(res.status).toBe(200);
		expect(await completionReportAtOf(issue.id)).toEqual(expect.any(Number));
		expect((await commentBodies(issue.id)).some((b) => b.includes("Did the thing"))).toBe(true);
	});

	it("never lets an agent (live lease) transition an issue to done, report or not", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Agent tries done" });
		await seedAgentLease(workspaceId, issue.id);

		const res = await patch(issue.id, { status: "done", completionReport: report });
		expect(res.status).toBe(403);
	});

	// --- Regression: the closed bypasses (PROJ-287) ---

	it("REGRESSION: omitting agentSessionId does not let an agent-leased issue skip the done gate", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Omit bypass" });
		await seedAgentLease(workspaceId, issue.id);

		// No agentSessionId at all — previously treated as human and allowed straight to done.
		const res = await patch(issue.id, { status: "done", completionReport: report });
		expect(res.status).toBe(403);
	});

	it("REGRESSION: a self-declared kind:human session cannot escape a live agent lease", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Human spoof" });
		await seedAgentLease(workspaceId, issue.id, { kind: "agent" });
		// Attach a human-kind session too; it must not downgrade the live agent lease.
		const human = await seedAgentLease(workspaceId, issue.id, { kind: "human", live: false });

		const res = await patch(issue.id, {
			status: "done",
			agentSessionId: human.agentSessionId,
			completionReport: report,
		});
		expect(res.status).toBe(403);
	});

	it("REGRESSION: a stale/ended agentSessionId no longer hard-404s a valid update", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Stale session" });

		const res = await patch(issue.id, {
			status: "todo",
			agentSessionId: crypto.randomUUID(), // never existed
		});
		expect(res.status).toBe(200);
	});

	// --- Human path scoped to agent-worked issues (PROJ-289) ---

	it("lets a human close a never-agent-leased issue with no report", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Plain human close" });

		const res = await patch(issue.id, { status: "done" });
		expect(res.status).toBe(200);
	});

	it("still requires a report to close an agent-worked issue (lease no longer live)", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Agent worked" });
		await seedAgentLease(workspaceId, issue.id, { live: false });

		expect((await patch(issue.id, { status: "done" })).status).toBe(400);
		expect((await patch(issue.id, { status: "done", completionReport: report })).status).toBe(200);
	});

	// --- Custom review status keyed on the word, not the literal (PROJ-292) ---

	it("gates a custom review status (category in_progress) the same as in_review", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Custom review" });
		await seedAgentLease(workspaceId, issue.id);
		const custom = await seedTaskStatus(workspaceId, {
			key: "code-review",
			name: "Code Review",
			category: "in_progress",
		});

		expect((await patch(issue.id, { statusId: custom.id })).status).toBe(400);
		expect((await patch(issue.id, { statusId: custom.id, completionReport: report })).status).toBe(
			200
		);
	});

	// --- REST/MCP parity (PROJ-301) ---

	it("MCP parity: update_issue enforces the done gate on an agent-leased issue", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "MCP done" });
		await seedAgentLease(workspaceId, issue.id);

		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "update_issue",
					arguments: { id: issue.id, status: "done", completionReport: report },
				},
			}),
		});
		// Agent holds a live lease → an agent cannot mark done; surfaced as a tool error.
		expect(JSON.stringify(await res.json())).toMatch(/agent cannot mark/i);
	});

	// --- Report stamped only on a real transition (PROJ-293) ---

	it("does not stamp/post a completionReport on a title-only update", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Pre-stamp attempt" });

		const res = await patch(issue.id, { title: "Renamed", completionReport: report });
		expect(res.status).toBe(200);
		expect(await completionReportAtOf(issue.id)).toBeNull();
		expect((await commentBodies(issue.id)).some((b) => b.includes("Did the thing"))).toBe(false);
	});
});
