import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture, toolError } from "./helpers";

describe("PROJ-1011: compound writes on create_issue and update_issue", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let otherRef: string;
	let otherId: string;

	async function call(name: string, args: Record<string, unknown>) {
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

	const report = {
		summary: "Shipped it",
		verification: "https://github.com/acme/repo/pull/12",
	};

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
		otherId = other.id;
		otherRef = `PROJ-${other.number}`;
	});

	async function registerAgent(): Promise<string> {
		const { err, data } = await call("register_agent", { name: "compound" });
		expect(err).toBeUndefined();
		return data.id as string;
	}

	async function issueRow(id: string) {
		return env.DB.prepare(
			"SELECT status, completed_at, done_at, completion_report_at, needs_audit FROM issues WHERE id = ?"
		)
			.bind(id)
			.first<{
				status: string;
				completed_at: number | null;
				done_at: number | null;
				completion_report_at: number | null;
				needs_audit: number;
			}>();
	}

	async function comments(issueId: string) {
		const rows = await env.DB.prepare(
			"SELECT id, body FROM issue_comments WHERE issue_id = ? ORDER BY created_at, body"
		)
			.bind(issueId)
			.all<{ id: string; body: string }>();
		return rows.results;
	}

	it("create_issue straight into done records the report, a comment and links in one call", async () => {
		const agentSessionId = await registerAgent();
		const { err, data } = await call("create_issue", {
			projectId,
			title: "Already finished",
			status: "done",
			agentSessionId,
			completionReport: report,
			comment: "Context for reviewers",
			links: [{ type: "follows_from", target: otherRef }],
		});
		expect(err).toBeUndefined();
		expect(data.commentId).toEqual(expect.any(String));
		expect(data.linkIds).toHaveLength(1);
		expect(data.needsAudit).toBeUndefined();

		const row = await issueRow(data.id);
		expect(row?.status).toBe("done");
		expect(row?.completed_at).toEqual(expect.any(Number));
		expect(row?.done_at).toEqual(expect.any(Number));
		expect(row?.completion_report_at).toEqual(expect.any(Number));
		expect(row?.needs_audit).toBe(0);

		const bodies = (await comments(data.id)).map((c) => c.body);
		expect(bodies).toContain("Context for reviewers");
		expect(bodies.some((b) => b.includes("Shipped it"))).toBe(true);

		const link = await env.DB.prepare(
			"SELECT source_issue_id, target_issue_id, type FROM issue_links WHERE id = ?"
		)
			.bind(data.linkIds[0])
			.first();
		expect(link).toEqual({
			source_issue_id: data.id,
			target_issue_id: otherId,
			type: "follows_from",
		});
	});

	it("flags an agent's create with unverifiable evidence for audit", async () => {
		const agentSessionId = await registerAgent();
		const { err, data } = await call("create_issue", {
			projectId,
			title: "Trust me",
			status: "done",
			agentSessionId,
			completionReport: { summary: "Done", verification: "I checked it" },
		});
		expect(err).toBeUndefined();
		expect(data.needsAudit).toBe(true);
		expect((await issueRow(data.id))?.needs_audit).toBe(1);
	});

	it("an agent creating into done must send a completion report", async () => {
		const agentSessionId = await registerAgent();
		const { err } = await call("create_issue", {
			projectId,
			title: "No report",
			status: "done",
			agentSessionId,
		});
		expect(JSON.stringify(err)).toMatch(/completionReport/);
	});

	it("rejects a completion report on an issue that isn't created in review or done", async () => {
		const { err } = await call("create_issue", {
			projectId,
			title: "Still open",
			completionReport: report,
		});
		expect(JSON.stringify(err)).toMatch(/completionReport/);
	});

	it("writes nothing when a link target doesn't exist", async () => {
		const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?")
			.bind(projectId)
			.first<{ n: number }>();
		const { err } = await call("create_issue", {
			projectId,
			title: "Bad link",
			comment: "never written",
			links: [{ type: "blocks", target: "PROJ-99999" }],
		});
		expect(err).toBeDefined();
		const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?")
			.bind(projectId)
			.first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
	});

	it("rejects the same link twice", async () => {
		const { err } = await call("create_issue", {
			projectId,
			title: "Twice",
			links: [
				{ type: "relates_to", target: otherRef },
				{ type: "relates_to", target: otherId },
			],
		});
		expect(JSON.stringify(err)).toMatch(/Duplicate link/);
	});

	it("canonicalises blocked_by from the new issue's side", async () => {
		const { err, data } = await call("create_issue", {
			projectId,
			title: "Blocked",
			links: [{ type: "blocked_by", target: otherRef }],
		});
		expect(err).toBeUndefined();
		const link = await env.DB.prepare(
			"SELECT source_issue_id, target_issue_id, type FROM issue_links WHERE id = ?"
		)
			.bind(data.linkIds[0])
			.first();
		expect(link).toEqual({ source_issue_id: otherId, target_issue_id: data.id, type: "blocks" });
	});

	it("a done create with a remainder spawns the follow-up", async () => {
		const { err, data } = await call("create_issue", {
			projectId,
			title: "Mostly done",
			status: "done",
			completionReport: { ...report, remainder: "One caller left" },
		});
		expect(err).toBeUndefined();
		expect(data.followUp.ref).toMatch(/^PROJ-\d+$/);
	});

	it("create_issue without the new fields keeps its old response", async () => {
		const { err, data } = await call("create_issue", { projectId, title: "Plain" });
		expect(err).toBeUndefined();
		expect(Object.keys(data).sort()).toEqual(["id", "number"]);
	});

	it("update_issue writes a comment after the update in the same call", async () => {
		const { err, data } = await call("update_issue", {
			id: otherRef,
			priority: "high",
			comment: "Bumped: blocks the release",
		});
		expect(err).toBeUndefined();
		expect(data.commentId).toEqual(expect.any(String));
		const row = await env.DB.prepare("SELECT priority FROM issues WHERE id = ?")
			.bind(otherId)
			.first<{ priority: string }>();
		expect(row?.priority).toBe("high");
		expect((await comments(otherId)).map((c) => c.body)).toContain("Bumped: blocks the release");
	});

	it("update_issue with a report and a comment writes both", async () => {
		const { err, data } = await call("update_issue", {
			id: otherRef,
			status: "done",
			completionReport: report,
			comment: "Closing note",
		});
		expect(err).toBeUndefined();
		const bodies = (await comments(otherId)).map((c) => c.body);
		expect(bodies).toContain("Closing note");
		expect(bodies.some((b) => b.includes("Shipped it"))).toBe(true);
		expect(data.commentId).toEqual(expect.any(String));
	});

	it("update_issue rejects a comment alone and writes nothing", async () => {
		const { err } = await call("update_issue", { id: otherRef, comment: "Just a note" });
		expect(JSON.stringify(err)).toMatch(/add_comment/);
		expect(await comments(otherId)).toHaveLength(0);
	});

	it("REST create accepts the compound fields", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Via REST",
				comment: "hello",
				links: [{ type: "relates_to", target: otherRef }],
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; commentId: string; linkIds: string[] };
		expect(body.commentId).toEqual(expect.any(String));
		expect(body.linkIds).toHaveLength(1);
	});
});
