import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture, toolError } from "./helpers";

// PROJ-961: completionReport.remainder on a done transition creates a linked follow-up.

describe("PROJ-961: completionReport.remainder", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let epicId: string;
	let issueId: string;
	let ref: string;

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
		summary: "Did most of it",
		verification: "https://github.com/acme/repo/commit/abcdef1234567",
	};

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	async function followUpRows() {
		const rows = await env.DB.prepare(
			"SELECT source_issue_id, target_issue_id, type FROM issue_links WHERE target_issue_id = ? AND type = 'follows_from'"
		)
			.bind(issueId)
			.all<{ source_issue_id: string; target_issue_id: string; type: string }>();
		return rows.results;
	}

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		const epic = await seedIssue(workspaceId, projectId, userId, { title: "Epic" });
		epicId = epic.id;
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Big task",
			parentId: epicId,
		});
		issueId = issue.id;
		ref = `PROJ-${issue.number}`;
		await env.DB.prepare("UPDATE issues SET labels = ? WHERE id = ?")
			.bind(JSON.stringify(["found-in-run", "tech-debt"]), issueId)
			.run();
	});

	it("update_issue → done with a remainder creates a follow-up under the same parent and labels", async () => {
		const { err, data } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: { ...report, remainder: "Migrate the other 3 callers" },
		});
		expect(err).toBeUndefined();
		expect(data.followUp.ref).toMatch(/^PROJ-\d+$/);

		const row = await env.DB.prepare(
			"SELECT id, title, body, labels, parent_id, status_category FROM issues WHERE id = ?"
		)
			.bind(data.followUp.id)
			.first<{
				title: string;
				body: string;
				labels: string;
				parent_id: string;
				status_category: string;
			}>();
		expect(row?.parent_id).toBe(epicId);
		expect(JSON.parse(row?.labels ?? "[]")).toEqual(["found-in-run", "tech-debt"]);
		expect(row?.title).toContain("Big task");
		expect(row?.body).toContain("Migrate the other 3 callers");
		expect(row?.body).toContain(ref);
		expect(row?.status_category).not.toBe("done");

		const links = await followUpRows();
		expect(links).toHaveLength(1);
		expect(links[0].source_issue_id).toBe(data.followUp.id);
	});

	it("the follow-up is reachable by the returned ref, and links read both ways", async () => {
		const { data } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: { ...report, remainder: "Rest of it" },
		});
		const fetched = await call("get_issue", { ref: data.followUp.ref });
		expect(fetched.err).toBeUndefined();

		const original = await call("list_issue_links", { issueId: ref });
		expect(original.data.items ?? original.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "followed_by", linkedIssueNumber: expect.any(Number) }),
			])
		);
		const followUp = await call("list_issue_links", { issueId: data.followUp.ref });
		expect(followUp.data.items ?? followUp.data).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "follows_from" })])
		);
	});

	it("finish_work returns followUp.ref and still ends the session", async () => {
		const start = await call("start_work", { issue: ref, name: "worker" });
		const { err, data } = await call("finish_work", {
			sessionId: start.data.sessionId,
			issue: ref,
			status: "done",
			completionReport: { ...report, remainder: "Left over" },
		});
		expect(err).toBeUndefined();
		expect(data.followUp.ref).toMatch(/^PROJ-\d+$/);
		const session = await env.DB.prepare("SELECT status FROM agent_sessions WHERE id = ?")
			.bind(start.data.sessionId)
			.first<{ status: string }>();
		expect(session?.status).toBe("ended");
	});

	it("no remainder → no follow-up", async () => {
		const { err, data } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: report,
		});
		expect(err).toBeUndefined();
		expect(data.followUp).toBeUndefined();
		expect(await followUpRows()).toHaveLength(0);
	});

	it("a remainder on a non-done transition creates nothing", async () => {
		const { err, data } = await call("update_issue", {
			id: ref,
			status: "in_review",
			completionReport: { ...report, remainder: "later" },
		});
		expect(err).toBeUndefined();
		expect(data.followUp).toBeUndefined();
		expect(await followUpRows()).toHaveLength(0);
	});

	it("re-sending the done update does not create a second follow-up", async () => {
		const input = {
			id: ref,
			status: "done",
			completionReport: { ...report, remainder: "once only" },
		};
		const first = await call("update_issue", input);
		expect(first.data.followUp).toBeDefined();
		const second = await call("update_issue", input);
		expect(second.data.followUp).toBeUndefined();
		expect(await followUpRows()).toHaveLength(1);
	});

	it("a top-level issue (no parent) gets a top-level follow-up", async () => {
		await env.DB.prepare("UPDATE issues SET parent_id = NULL WHERE id = ?").bind(issueId).run();
		const { data } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: { ...report, remainder: "x" },
		});
		const row = await env.DB.prepare("SELECT parent_id FROM issues WHERE id = ?")
			.bind(data.followUp.id)
			.first<{ parent_id: string | null }>();
		expect(row?.parent_id).toBeNull();
	});

	it("create_issue_link accepts follows_from directly", async () => {
		const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
		const { err } = await call("create_issue_link", {
			sourceIssueId: other.id,
			targetIssueId: ref,
			type: "follows_from",
		});
		expect(err).toBeUndefined();
		expect(await followUpRows()).toHaveLength(1);
	});

	it("REST PATCH returns followUp too (parity)", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				status: "done",
				completionReport: { ...report, remainder: "via REST" },
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { followUp?: { ref: string } };
		expect(body.followUp?.ref).toMatch(/^PROJ-\d+$/);
	});

	for (const blank of ["", "   "]) {
		it(`PROJ-993: remainder ${JSON.stringify(blank)} is treated as absent`, async () => {
			const { err, data } = await call("update_issue", {
				id: ref,
				status: "done",
				completionReport: { ...report, remainder: blank },
			});
			expect(err).toBeUndefined();
			expect(data.followUp).toBeUndefined();
			expect(await followUpRows()).toHaveLength(0);
		});
	}

	it("PROJ-993: finish_work accepts a blank remainder", async () => {
		const reg = await call("register_agent", { name: "w", issueId: issueId });
		const { err, data } = await call("finish_work", {
			sessionId: reg.data.id,
			issue: ref,
			status: "done",
			completionReport: { ...report, remainder: "" },
		});
		expect(err).toBeUndefined();
		expect(JSON.stringify(data)).not.toContain("followUp");
	});

	it("PROJ-997: a missing completionReport subfield is named by its path", async () => {
		const { err } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: { verification: "ci" },
		});
		expect(err?.code).toBe("validation");
		expect(JSON.stringify(err)).toContain("completionReport.summary");
	});

	it("PROJ-997: an unknown completionReport key is named", async () => {
		const { err } = await call("update_issue", {
			id: ref,
			status: "done",
			completionReport: { ...report, followUps: "x" },
		});
		expect(err?.code).toBe("validation");
		expect(JSON.stringify(err)).toContain("completionReport.followUps");
	});
});
