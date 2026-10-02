import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProject, seedProjectFixture, toolError } from "./helpers";

// PROJ-959: every MCP tool that takes an issue id accepts a UUID or a ref like "PROJ-42".
// One test per tool, each passing the *ref*, so a tool that regresses to UUID-only fails
// here by name. Tools that already resolved refs before PROJ-959 (get_issue, update_issue,
// create_issue_link, list_issue_links) have their own coverage in issues/issue-links tests.

describe("PROJ-959: issue refs accepted by every issue-id tool", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
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
		const json = (await res.json()) as {
			result?: { isError?: boolean; content?: Array<{ text: string }> };
		};
		const err = toolError(json);
		const text = json.result?.content?.[0]?.text;
		// biome-ignore lint/suspicious/noExplicitAny: tool results are heterogeneous JSON
		const data = (text && !err ? JSON.parse(text) : undefined) as any;
		return { err, data };
	}

	async function register(name = "agent"): Promise<string> {
		const { err, data } = await call("register_agent", { name });
		expect(err).toBeUndefined();
		return data.id as string;
	}

	// Headroom over wrangler.test.toml's RATE_LIMIT_API_MAX (5) so a test may make several calls.
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Target" });
		issueId = issue.id;
		ref = `PROJ-${issue.number}`;
	});

	describe("comments", () => {
		it("add_comment", async () => {
			const { err, data } = await call("add_comment", { issueId: ref, body: "via ref" });
			expect(err).toBeUndefined();
			expect(data.id).toBeTruthy();
			const row = await env.DB.prepare("SELECT issue_id FROM issue_comments WHERE id = ?")
				.bind(data.id)
				.first<{ issue_id: string }>();
			expect(row?.issue_id).toBe(issueId);
		});

		it("list_comments", async () => {
			await call("add_comment", { issueId, body: "one" });
			const { err, data } = await call("list_comments", { issueId: ref });
			expect(err).toBeUndefined();
			expect(data.items).toHaveLength(1);
		});

		it("update_comment", async () => {
			const created = await call("add_comment", { issueId, body: "before" });
			const { err } = await call("update_comment", {
				issueId: ref,
				commentId: created.data.id,
				body: "after",
			});
			expect(err).toBeUndefined();
			const row = await env.DB.prepare("SELECT body FROM issue_comments WHERE id = ?")
				.bind(created.data.id)
				.first<{ body: string }>();
			expect(row?.body).toBe("after");
		});

		it("delete_comment", async () => {
			const created = await call("add_comment", { issueId, body: "gone" });
			const { err } = await call("delete_comment", { issueId: ref, commentId: created.data.id });
			expect(err).toBeUndefined();
			const row = await env.DB.prepare("SELECT id FROM issue_comments WHERE id = ?")
				.bind(created.data.id)
				.first();
			expect(row).toBeNull();
		});

		it("an unknown ref is not_found, same as an unknown UUID", async () => {
			const unknownRef = await call("add_comment", { issueId: "PROJ-9999", body: "x" });
			expect(unknownRef.err?.code).toBe("not_found");
			expect(unknownRef.err?.message).toBe("Issue not found");
			const unknownUuid = await call("add_comment", { issueId: crypto.randomUUID(), body: "x" });
			expect(unknownUuid.err?.message).toBe(unknownRef.err?.message);
		});

		it("a malformed id still fails validation-free as not_found, not a 500", async () => {
			const { err } = await call("add_comment", { issueId: "not-a-ref", body: "x" });
			expect(err?.code).toBe("not_found");
		});
	});

	describe("leases", () => {
		it("claim_issue, list_issue_leases and release_issue", async () => {
			const agentId = await register();
			const claim = await call("claim_issue", { issueId: ref, agentId });
			expect(claim.err).toBeUndefined();
			expect(claim.data.issueId).toBe(issueId);

			const list = await call("list_issue_leases", { issueId: ref });
			expect(list.err).toBeUndefined();
			expect(list.data.items).toHaveLength(1);

			const release = await call("release_issue", { issueId: ref, agentId });
			expect(release.err).toBeUndefined();
			const after = await call("list_issue_leases", { issueId: ref });
			expect(after.data.items).toHaveLength(0);
		});

		it("list_issue_leases with an unknown ref is an empty list, not an error", async () => {
			const { err, data } = await call("list_issue_leases", { issueId: "PROJ-9999" });
			expect(err).toBeUndefined();
			expect(data.items).toHaveLength(0);
		});
	});

	describe("file claims", () => {
		it("claim_files, list_file_claims and release_files", async () => {
			const agentId = await register();
			const claim = await call("claim_files", { issueId: ref, agentId, paths: ["src/a.ts"] });
			expect(claim.err).toBeUndefined();

			const list = await call("list_file_claims", { issueId: ref });
			expect(list.err).toBeUndefined();
			expect(list.data.items).toHaveLength(1);
			expect(list.data.items[0].issueId).toBe(issueId);

			const release = await call("release_files", { issueId: ref, paths: ["src/a.ts"] });
			expect(release.err).toBeUndefined();
			const after = await call("list_file_claims", { issueId: ref });
			expect(after.data.items).toHaveLength(0);
		});
	});

	describe("agent sessions", () => {
		it("register_agent links the session to the resolved UUID", async () => {
			const { err, data } = await call("register_agent", { name: "linked", issueId: ref });
			expect(err).toBeUndefined();
			expect(data.issueId).toBe(issueId);
		});

		it("register_agent with an unknown ref is not_found", async () => {
			const { err } = await call("register_agent", { name: "x", issueId: "PROJ-9999" });
			expect(err?.code).toBe("not_found");
		});

		it("start_work, list_active_agents and finish_work", async () => {
			const start = await call("start_work", { issue: ref, name: "worker", paths: ["src/b.ts"] });
			expect(start.err).toBeUndefined();
			expect(start.data.lease.issueId).toBe(issueId);

			const active = await call("list_active_agents", { issueId: ref });
			expect(active.err).toBeUndefined();
			expect(active.data.items).toHaveLength(1);

			const finish = await call("finish_work", { sessionId: start.data.sessionId, issue: ref });
			expect(finish.err).toBeUndefined();
		});

		it("start_work with an unknown ref fails before registering a session", async () => {
			const { err } = await call("start_work", { issue: "PROJ-9999", name: "ghost" });
			expect(err?.code).toBe("not_found");
			const sessions = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM agent_sessions WHERE workspace_id = ?"
			)
				.bind(workspaceId)
				.first<{ n: number }>();
			expect(sessions?.n).toBe(0);
		});
	});

	describe("agent messages", () => {
		it("a ref scope and a UUID scope are the same channel", async () => {
			const byRef = await call("post_message", { scope: `issue:${ref}`, body: "posted by ref" });
			expect(byRef.err).toBeUndefined();
			expect(byRef.data.scope).toBe(`issue:${issueId}`);
			await call("post_message", { scope: `issue:${issueId}`, body: "posted by uuid" });

			for (const scope of [`issue:${ref}`, `issue:${issueId}`]) {
				const list = await call("list_messages", { scope });
				expect(list.err).toBeUndefined();
				expect(list.data.items.map((m: { body: string }) => m.body)).toEqual([
					"posted by ref",
					"posted by uuid",
				]);
			}
		});

		it("an unknown ref scope is not_found; a malformed scope is still rejected", async () => {
			const unknown = await call("post_message", { scope: "issue:PROJ-9999", body: "x" });
			expect(unknown.err?.code).toBe("not_found");
			const bad = await call("post_message", { scope: "issue:nonsense", body: "x" });
			expect(bad.err?.code).toBe("validation");
		});
	});

	describe("sprints", () => {
		it("move_issues_to_sprint accepts refs and UUIDs mixed", async () => {
			const second = await seedIssue(workspaceId, projectId, userId, { title: "Second" });
			const sprint = await call("create_sprint", { projectId, name: "S1" });
			expect(sprint.err).toBeUndefined();

			const { err, data } = await call("move_issues_to_sprint", {
				sprintId: sprint.data.id,
				issueIds: [ref, second.id],
			});
			expect(err).toBeUndefined();
			expect(data.count).toBe(2);
			const rows = await env.DB.prepare("SELECT sprint_id FROM issues WHERE id IN (?, ?)")
				.bind(issueId, second.id)
				.all<{ sprint_id: string }>();
			expect(rows.results.map((r) => r.sprint_id)).toEqual([sprint.data.id, sprint.data.id]);
		});

		it("one unknown ref fails the whole batch and moves nothing", async () => {
			const sprint = await call("create_sprint", { projectId, name: "S2" });
			const { err } = await call("move_issues_to_sprint", {
				sprintId: sprint.data.id,
				issueIds: [ref, "PROJ-9999"],
			});
			expect(err?.code).toBe("not_found");
			expect(err?.message).toContain("PROJ-9999");
			const row = await env.DB.prepare("SELECT sprint_id FROM issues WHERE id = ?")
				.bind(issueId)
				.first<{ sprint_id: string | null }>();
			expect(row?.sprint_id).toBeNull();
		});
	});

	describe("attachments", () => {
		it("create_link_attachment and list_attachments store and read the canonical UUID", async () => {
			const created = await call("create_link_attachment", {
				kind: "url",
				entityType: "issue",
				entityId: ref,
				url: "https://example.com/spec",
				label: "Spec",
			});
			expect(created.err).toBeUndefined();
			const row = await env.DB.prepare("SELECT entity_id FROM attachments WHERE id = ?")
				.bind(created.data.id)
				.first<{ entity_id: string }>();
			expect(row?.entity_id).toBe(issueId);

			const byRef = await call("list_attachments", { entityType: "issue", entityId: ref });
			const byUuid = await call("list_attachments", { entityType: "issue", entityId: issueId });
			expect(byRef.err).toBeUndefined();
			expect(byRef.data).toEqual(byUuid.data);
		});

		it("list_attachments with an unknown ref is empty, not an error", async () => {
			const { err, data } = await call("list_attachments", {
				entityType: "issue",
				entityId: "PROJ-9999",
			});
			expect(err).toBeUndefined();
			expect(data.items ?? data).toHaveLength(0);
		});
	});

	describe("project visibility is not bypassed by a ref", () => {
		// The fixture user is a plain member granted only on PROJ; HIDN has no grant.
		let hiddenRef: string;
		let hiddenId: string;

		beforeEach(async () => {
			const hidden = await seedProject(workspaceId, "HIDN");
			const secret = await seedIssue(workspaceId, hidden.id, userId, { title: "Secret" });
			hiddenRef = `HIDN-${secret.number}`;
			hiddenId = secret.id;
		});

		// Each strict tool must answer a hidden ref exactly like an unknown one, and the
		// hidden issue's UUID must never appear in the response.
		const strict: Array<[string, (issue: string, agentId: string) => Record<string, unknown>]> = [
			["add_comment", (issueId) => ({ issueId, body: "x" })],
			["claim_issue", (issueId, agentId) => ({ issueId, agentId })],
			["claim_files", (issueId, agentId) => ({ issueId, agentId, paths: ["a.ts"] })],
			["register_agent", (issueId) => ({ name: "n", issueId })],
			["start_work", (issueId) => ({ issue: issueId, name: "w" })],
			["post_message", (issueId) => ({ scope: `issue:${issueId}`, body: "x" })],
			[
				"create_link_attachment",
				(issueId) => ({
					kind: "url",
					entityType: "issue",
					entityId: issueId,
					url: "https://example.com",
					label: "l",
				}),
			],
		];

		for (const [tool, args] of strict) {
			it(`${tool}: hidden ref is indistinguishable from an unknown ref`, async () => {
				const agentId = await register();
				const hiddenRes = await call(tool, args(hiddenRef, agentId));
				const unknownRes = await call(tool, args("HIDN-9999", agentId));
				expect(hiddenRes.err?.code).toBe("not_found");
				expect(hiddenRes.err?.message).toBe(
					unknownRes.err?.message?.replace("HIDN-9999", hiddenRef)
				);
				expect(JSON.stringify(hiddenRes)).not.toContain(hiddenId);
			});
		}

		it("move_issues_to_sprint: hidden ref in the batch fails like an unknown one", async () => {
			const sprint = await call("create_sprint", { projectId, name: "S" });
			const hiddenRes = await call("move_issues_to_sprint", {
				sprintId: sprint.data.id,
				issueIds: [hiddenRef],
			});
			expect(hiddenRes.err?.code).toBe("not_found");
			expect(hiddenRes.err?.message).toBe(`Issue not found: ${hiddenRef}`);
			expect(JSON.stringify(hiddenRes)).not.toContain(hiddenId);
		});

		it("release_issue / finish_work: hidden ref is not_found without leaking the UUID", async () => {
			const agentId = await register();
			const release = await call("release_issue", { issueId: hiddenRef, agentId });
			expect(JSON.stringify(release)).not.toContain(hiddenId);
			const start = await call("start_work", { issue: ref, name: "w" });
			const finish = await call("finish_work", {
				sessionId: start.data.sessionId,
				issue: hiddenRef,
			});
			expect(finish.err?.code).toBe("not_found");
			expect(JSON.stringify(finish)).not.toContain(hiddenId);
		});

		it("list filters treat a hidden ref as empty, same as unknown", async () => {
			const leases = await call("list_issue_leases", { issueId: hiddenRef });
			expect(leases.err).toBeUndefined();
			expect(leases.data.items).toHaveLength(0);
			const msgs = await call("list_messages", { scope: `issue:${hiddenRef}` });
			expect(msgs.err).toBeUndefined();
			expect(msgs.data.items).toHaveLength(0);
			const unknown = await call("list_messages", { scope: "issue:HIDN-9999" });
			expect(unknown.data.items).toHaveLength(0);
		});
	});
});
