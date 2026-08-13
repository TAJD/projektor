import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedAgentLease,
	seedIssue,
	seedProjectFixture,
	seedTaskStatus,
} from "./helpers";

// PROJ-254 gate, hardened by PROJ-287/289/292/293: the in_review report requirement is
// bound to the issue's LIVE AGENT LEASE (an agent can't spoof it by omitting
// agentSessionId or self-declaring kind:"human"); the done-report requirement is scoped
// to agent-worked issues; review is keyed on any review-like status; the report is only
// stamped on a real transition. PROJ-375 removed the old block on an agent (live lease)
// transitioning to done — agents can close freely now; see the needsAudit tests below.
describe("Review gating (PROJ-254/287/289/292/293/375)", () => {
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

	async function needsAuditOf(id: string): Promise<boolean> {
		const row = await env.DB.prepare("SELECT needs_audit FROM issues WHERE id = ?")
			.bind(id)
			.first<{ needs_audit: number }>();
		return Boolean(row?.needs_audit);
	}

	async function commentBodies(id: string): Promise<string[]> {
		const res = await SELF.fetch(`http://localhost/api/issues/${id}/comments`, {
			headers: authHeaders(token, slug),
		});
		const comments = (await res.json()) as Array<{ body: string }>;
		return comments.map((c) => c.body);
	}

	const report = { summary: "Did the thing", verification: "pnpm test" };

	async function seedFlaggedAndCleanDoneIssues() {
		const flagged = await seedIssue(workspaceId, projectId, userId, { title: "Flagged" });
		const clean = await seedIssue(workspaceId, projectId, userId, { title: "Clean" });
		const { agentSessionId: flaggedAgent } = await seedAgentLease(workspaceId, flagged.id);
		const { agentSessionId: cleanAgent } = await seedAgentLease(workspaceId, clean.id);

		await patch(flagged.id, {
			status: "done",
			agentSessionId: flaggedAgent,
			completionReport: report,
		});
		await patch(clean.id, {
			status: "done",
			agentSessionId: cleanAgent,
			completionReport: {
				summary: "Did the thing",
				verification: "https://github.com/TAJD/projektor/pull/93",
			},
		});

		return { flagged, clean };
	}

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

	// --- PROJ-375: agents close to done directly, no block ---

	it("lets an agent (live lease) transition an issue directly to done", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Agent closes" });
		const { agentSessionId } = await seedAgentLease(workspaceId, issue.id);

		const res = await patch(issue.id, { status: "done", agentSessionId, completionReport: report });
		expect(res.status).toBe(200);
	});

	it("flags an agent-initiated done closure with freeform verification as needsAudit", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Freeform close" });
		const { agentSessionId } = await seedAgentLease(workspaceId, issue.id);

		await patch(issue.id, { status: "done", agentSessionId, completionReport: report });
		expect(await needsAuditOf(issue.id)).toBe(true);
	});

	it("does not flag an agent-initiated done closure with an externally-checkable link", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Verifiable close" });
		const { agentSessionId } = await seedAgentLease(workspaceId, issue.id);

		await patch(issue.id, {
			status: "done",
			agentSessionId,
			completionReport: {
				summary: "Did the thing",
				verification: "https://github.com/TAJD/projektor/pull/93 — CI green",
			},
		});
		expect(await needsAuditOf(issue.id)).toBe(false);
	});

	it("does not flag a human-initiated done closure (no agentSessionId) even with freeform evidence", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Human closes" });
		await seedAgentLease(workspaceId, issue.id, { live: false });

		await patch(issue.id, { status: "done", completionReport: report });
		expect(await needsAuditOf(issue.id)).toBe(false);
	});

	it("does not flag when the agentSessionId given is not a live session (accepted limitation)", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Stale session close" });
		await seedAgentLease(workspaceId, issue.id, { live: false });

		await patch(issue.id, {
			status: "done",
			agentSessionId: crypto.randomUUID(), // never existed — can't resolve to a live session
			completionReport: report,
		});
		expect(await needsAuditOf(issue.id)).toBe(false);
	});

	it("flags needsAudit even once the agent's lease has been released before closing", async () => {
		// The exact scenario PROJ-375 was filed for: release_issue then update_issue done.
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Released then closed",
		});
		const { agentSessionId } = await seedAgentLease(workspaceId, issue.id);
		await SELF.fetch(`http://localhost/api/issues/${issue.id}/release`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentId: agentSessionId }),
		});

		const res = await patch(issue.id, { status: "done", agentSessionId, completionReport: report });
		expect(res.status).toBe(200);
		expect(await needsAuditOf(issue.id)).toBe(true);
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

	// --- REST/MCP parity (PROJ-301/375) ---

	it("MCP parity: update_issue lets an agent close directly to done and flags weak evidence", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "MCP done" });
		const { agentSessionId } = await seedAgentLease(workspaceId, issue.id);

		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "update_issue",
					arguments: { id: issue.id, status: "done", agentSessionId, completionReport: report },
				},
			}),
		});
		const body = (await res.json()) as { result?: unknown; error?: unknown };
		expect(body.error).toBeUndefined();
		expect(body.result).toBeDefined();
		expect(await needsAuditOf(issue.id)).toBe(true);
	});

	// --- Audit query filter (PROJ-375) ---

	it("list_issues({ needsAudit: true }) surfaces flagged closures only", async () => {
		const { flagged, clean } = await seedFlaggedAndCleanDoneIssues();

		const res = await SELF.fetch(
			`http://localhost/api/issues?projectId=${projectId}&needsAudit=true`,
			{ headers: authHeaders(token, slug) }
		);
		const { items } = (await res.json()) as { items: Array<{ id: string }> };
		const ids = items.map((i) => i.id);
		expect(ids).toContain(flagged.id);
		expect(ids).not.toContain(clean.id);
	});

	it("list_issues({ needsAudit: false }) surfaces unflagged closures only (PROJ-449)", async () => {
		const { flagged, clean } = await seedFlaggedAndCleanDoneIssues();

		// z.coerce.boolean() would coerce the string "false" to true, silently
		// inverting this filter. Guards against regressing to that.
		const res = await SELF.fetch(
			`http://localhost/api/issues?projectId=${projectId}&needsAudit=false`,
			{ headers: authHeaders(token, slug) }
		);
		const { items } = (await res.json()) as { items: Array<{ id: string }> };
		const ids = items.map((i) => i.id);
		expect(ids).toContain(clean.id);
		expect(ids).not.toContain(flagged.id);
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
