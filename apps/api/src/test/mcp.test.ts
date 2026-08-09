import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedMember,
	seedProject,
	seedUser,
} from "./helpers";

async function mcpFetch(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<Response> {
	return SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

async function mcpCall<T>(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await mcpFetch(workspaceId, method, params, headers);
	return res.json();
}

type IssuePage = { items: Array<Record<string, unknown>>; nextCursor: number | null };

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("MCP endpoint", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let headers: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		headers = authHeaders(token, slug);
		const project = await seedProject(workspaceId);
		projectId = project.id;
		await seedGroupGrant(workspaceId, fixture.user.id, projectId);
	});

	it("initialize returns server info", async () => {
		const res = (await mcpCall(workspaceId, "initialize", {}, headers)) as JsonRpcResult<{
			protocolVersion: string;
			serverInfo: { name: string; version: string };
			instructions: string;
		}>;
		// "2025-11-25" is the latest *legacy* protocol version (initialize handshake).
		// "2026-07-28" denotes the modern per-request `_meta` era, which has no
		// initialize method — claiming it here while still running the legacy
		// handshake would misrepresent what this server actually implements.
		expect(res.result.protocolVersion).toBe("2025-11-25");
		expect(res.result.serverInfo.name).toBe("projektor");
		// __PROJEKTOR_VERSION__ is only injected by the release build (scripts/build-release.sh);
		// tests run without that define, so the fallback applies.
		expect(res.result.serverInfo.version).toBe("dev");
		// Instructions point at the canonical workflow spec rather than restating rules (PROJ-251).
		expect(res.result.instructions).toContain("get_workflow");
		// PROJ-599: instructions point working-an-epic agents at the shipped playbook.
		expect(res.result.instructions).toContain('get_playbook("epic-goal")');
		// PROJ-600: capabilities advertise the native prompts primitive.
		expect(res.result).toHaveProperty("capabilities.prompts");
	});

	it("initialize response carries no session identifier (PROJ-452)", async () => {
		const res = await mcpFetch(workspaceId, "initialize", {}, headers);
		expect(res.headers.get("Mcp-Session-Id")).toBeNull();
		const body = (await res.json()) as JsonRpcResult<Record<string, unknown>>;
		expect(body.result).not.toHaveProperty("sessionId");
	});

	it("calls tools/list directly with no prior initialize and no session header (PROJ-452)", async () => {
		// The 2026-07-28 spec drops the initialize/initialized handshake and
		// Mcp-Session-Id requirement; this asserts projektor never depended on
		// either in the first place — a fresh request with no session state
		// attached succeeds identically to one preceded by `initialize`.
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(res.result.tools.length).toBeGreaterThan(0);
	});

	it("tools/list includes cache hints (PROJ-454)", async () => {
		const res = (await mcpCall<{ ttlMs: number; cacheScope: string }>(
			workspaceId,
			"tools/list",
			{},
			headers
		)) as JsonRpcResult<{ ttlMs: number; cacheScope: string }>;
		expect(res.result.ttlMs).toBeGreaterThan(0);
		expect(res.result.cacheScope).toBe("private");
	});

	it("tools/list returns core tools", async () => {
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("list_issues");
		expect(names).toContain("create_issue");
		expect(names).toContain("search_wiki");
		expect(names).toContain("get_wiki_page");
	});

	it("tools/call list_issues returns empty page initially", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "list_issues", arguments: {} },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as IssuePage;
		expect(Array.isArray(data.items)).toBe(true);
		expect(data.items).toHaveLength(0);
		expect(data.nextCursor).toBeNull();
	});

	it("tools/call create_issue then list_issues returns it", async () => {
		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "create_issue",
				arguments: { projectId, title: "MCP-created issue", priority: "high" },
			},
			headers
		);

		const listRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "list_issues", arguments: {} },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(listRes.result.content[0].text) as IssuePage;
		expect(data.items).toHaveLength(1);
		expect((data.items[0] as { title: string }).title).toBe("MCP-created issue");
		expect((data.items[0] as { priority: string }).priority).toBe("high");
	});

	it("tools/call search_wiki finds pages", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "MCP Docs", content: "How to use the MCP endpoint" }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "search_wiki", arguments: { query: "MCP endpoint" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const results = JSON.parse(res.result.content[0].text) as Array<{ title: string }>;
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].title).toBe("MCP Docs");
	});

	it("tools/call get_wiki_page retrieves a page", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Runbook", content: "## Steps" }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_wiki_page", arguments: { slug: "runbook" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const page = JSON.parse(res.result.content[0].text) as { title: string; content: string };
		expect(page.title).toBe("Runbook");
		expect(page.content).toBe("## Steps");
	});

	it("returns JSON-RPC error for unknown method", async () => {
		const res = (await mcpCall(workspaceId, "not/a/method", {}, headers)) as JsonRpcError;
		expect(res.error.code).toBe(-32601);
	});

	it("returns JSON-RPC error for unknown tool", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "does_not_exist", arguments: {} },
			headers
		)) as JsonRpcError;
		expect(res.error.code).toBe(-32601);
		expect(res.error.message).toContain("does_not_exist");
	});

	// PROJ-508: a ValidationError's Zod issues now travel in the JSON-RPC 2.0
	// `error.data` member instead of being dropped behind the bare "Invalid params"
	// message.
	it("tools/call ValidationError carries Zod issues in error.data", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "create_issue", arguments: { projectId, title: 123 } },
			headers
		)) as JsonRpcError;
		expect(res.error.code).toBe(-32602);
		expect(res.error.message).toContain("Invalid params");
		const data = res.error.data as { formErrors: string[]; fieldErrors: Record<string, string[]> };
		expect(data.fieldErrors.title).toBeTruthy();
		expect(res.error.message).toContain("title");
	});

	// A ServiceError with no structured `details` (e.g. a plain ValidationError-less
	// not-found) still omits `data` entirely rather than sending it as null.
	it("tools/call error without structured details omits error.data", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_issue", arguments: { id: crypto.randomUUID() } },
			headers
		)) as JsonRpcError;
		expect(res.error.code).toBe(-32000);
		expect("data" in res.error).toBe(false);
	});

	// --- Issues: REST/MCP parity tests ---

	it("MCP create_issue with assigneeId and labels persists them", async () => {
		const assignee = await seedUser("mcp-assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		const createRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{
				name: "create_issue",
				arguments: {
					projectId,
					title: "With assignee",
					assigneeId: assignee.id,
					labels: ["mcp", "test"],
				},
			},
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const created = JSON.parse(createRes.result.content[0].text) as { id: string };
		expect(created.id).toBeTruthy();

		const getRes = await SELF.fetch(`http://localhost/api/issues/${created.id}`, { headers });
		const issue = (await getRes.json()) as { assignee_id: string; labels: string };
		expect(issue.assignee_id).toBe(assignee.id);
		expect(JSON.parse(issue.labels)).toEqual(["mcp", "test"]);
	});

	it("MCP update_issue with assigneeId and labels updates them", async () => {
		const assignee = await seedUser("mcp-upd-assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		const createRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "create_issue", arguments: { projectId, title: "Before update" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { id } = JSON.parse(createRes.result.content[0].text) as { id: string };

		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "update_issue",
				arguments: { id, assigneeId: assignee.id, labels: ["updated"] },
			},
			headers
		);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, { headers });
		const issue = (await getRes.json()) as { assignee_id: string; labels: string };
		expect(issue.assignee_id).toBe(assignee.id);
		expect(JSON.parse(issue.labels)).toEqual(["updated"]);
	});

	it("MCP list_issues with assignee filter returns same subset as REST", async () => {
		const assignee = await seedUser("mcp-list-assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		// Create two issues; only one assigned
		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "create_issue",
				arguments: { projectId, title: "Unassigned" },
			},
			headers
		);
		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "create_issue",
				arguments: { projectId, title: "Assigned", assigneeId: assignee.id },
			},
			headers
		);

		// MCP filter
		const mcpRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "list_issues", arguments: { assignee: assignee.id } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpData = JSON.parse(mcpRes.result.content[0].text) as IssuePage;
		expect(mcpData.items).toHaveLength(1);
		expect((mcpData.items[0] as { title: string }).title).toBe("Assigned");

		// REST filter — same result
		const restRes = await SELF.fetch(`http://localhost/api/issues?assignee=${assignee.id}`, {
			headers,
		});
		const restData = (await restRes.json()) as IssuePage;
		expect(restData.items).toHaveLength(1);
		expect((restData.items[0] as { title: string }).title).toBe("Assigned");
	});

	it("MCP and REST list_issues return identical structure { items, nextCursor }", async () => {
		const mcpRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "list_issues", arguments: {} },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpData = JSON.parse(mcpRes.result.content[0].text) as IssuePage;

		const restRes = await SELF.fetch("http://localhost/api/issues", { headers });
		const restData = (await restRes.json()) as IssuePage;

		expect(Array.isArray(mcpData.items)).toBe(true);
		expect("nextCursor" in mcpData).toBe(true);
		expect(Array.isArray(restData.items)).toBe(true);
		expect("nextCursor" in restData).toBe(true);
	});

	it("MCP get_issue by ref returns issue", async () => {
		// Create via MCP; project key is 'PROJ', first issue = PROJ-1
		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "create_issue",
				arguments: { projectId, title: "Ref via MCP" },
			},
			headers
		);

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_issue", arguments: { ref: "PROJ-1" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const issue = JSON.parse(res.result.content[0].text) as { title: string };
		expect(issue.title).toBe("Ref via MCP");
	});

	it("MCP get_issue for unknown id returns error", async () => {
		const res = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_issue", arguments: { id: crypto.randomUUID() } },
			headers
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
		expect(res.error.message).toMatch(/not found/i);
	});

	// --- wiki parity tests ---

	it("MCP list_wiki_pages without parentId returns ALL pages", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Parent", content: "root" }),
		});
		const parent = (await parentRes.json()) as { id: string };

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Child", content: "child", parentId: parent.id }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "list_wiki_pages", arguments: {} },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const pages = JSON.parse(res.result.content[0].text) as unknown[];
		expect(pages).toHaveLength(2);
	});

	it("MCP search_wiki with empty query returns []", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Some Page", content: "content" }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "search_wiki", arguments: { query: "" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const results = JSON.parse(res.result.content[0].text) as unknown[];
		expect(results).toEqual([]);
	});

	it("MCP search_wiki excerpt is at most 250 chars", async () => {
		const longContent = "z".repeat(1000);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Verbose Page", content: longContent }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "search_wiki", arguments: { query: "Verbose" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const results = JSON.parse(res.result.content[0].text) as Array<{ excerpt: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].excerpt.length).toBeLessThanOrEqual(250);
	});

	it("MCP create_wiki_page without slug auto-generates from title", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "create_wiki_page", arguments: { title: "Auto Slug Page", content: "hi" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const created = JSON.parse(res.result.content[0].text) as { slug: string };
		expect(created.slug).toBe("auto-slug-page");
	});

	it("MCP update_wiki_page by id creates a revision when content changes", async () => {
		const createRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "create_wiki_page", arguments: { title: "Rev Test", content: "v1" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { id } = JSON.parse(createRes.result.content[0].text) as { id: string };

		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "update_wiki_page",
				arguments: { id, content: "v2" },
			},
			headers
		);

		const revRes = await SELF.fetch(`http://localhost/api/wiki/rev-test/revisions`, {
			headers,
		});
		const revisions = (await revRes.json()) as unknown[];
		expect(revisions).toHaveLength(1);
	});

	it("MCP update_wiki_page title-only update does not create a revision", async () => {
		const createRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "create_wiki_page", arguments: { title: "Title Only", content: "body" } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { id } = JSON.parse(createRes.result.content[0].text) as { id: string };

		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "update_wiki_page",
				arguments: { id, title: "New Title" },
			},
			headers
		);

		const revRes = await SELF.fetch("http://localhost/api/wiki/title-only/revisions", {
			headers,
		});
		const revisions = (await revRes.json()) as unknown[];
		expect(revisions).toHaveLength(0);
	});

	it("MCP update_wiki_page by slug works", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Slug Update", content: "original" }),
		});

		await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "update_wiki_page",
				arguments: { slug: "slug-update", content: "updated" },
			},
			headers
		);

		const pageRes = await SELF.fetch("http://localhost/api/wiki/slug-update", { headers });
		const page = (await pageRes.json()) as { content: string };
		expect(page.content).toBe("updated");
	});

	it("MCP create_wiki_page with invalid title returns a JSON-RPC error", async () => {
		const res = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "create_wiki_page", arguments: { title: "" } },
			headers
		)) as JsonRpcError;
		expect("error" in res).toBe(true);
		expect(res.error).toBeDefined();
	});

	it("MCP delete_wiki_page cascade=true removes the page and its subtree (PROJ-238)", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "MCP Cascade Parent", content: "" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "MCP Cascade Child", content: "", parentId: parent.id }),
		});
		const child = (await childRes.json()) as { slug: string };

		const delRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			owner.workspace.id,
			"tools/call",
			{ name: "delete_wiki_page", arguments: { slug: parent.slug, cascade: true } },
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		expect(JSON.parse(delRes.result.content[0].text)).toEqual({
			ok: true,
			deletedCount: 2,
			linkedByCount: 0,
		});

		const childRes2 = await SELF.fetch(`http://localhost/api/wiki/${child.slug}`, {
			headers: ownerHeaders,
		});
		expect(childRes2.status).toBe(404);
	});

	it("MCP delete_wiki_page default promotes children instead of deleting them", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "MCP Promote Parent", content: "" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "MCP Promote Child", content: "", parentId: parent.id }),
		});
		const child = (await childRes.json()) as { slug: string };

		await mcpCall(
			owner.workspace.id,
			"tools/call",
			{ name: "delete_wiki_page", arguments: { slug: parent.slug } },
			ownerHeaders
		);

		const childRes2 = await SELF.fetch(`http://localhost/api/wiki/${child.slug}`, {
			headers: ownerHeaders,
		});
		expect(childRes2.status).toBe(200);
		const childPage = (await childRes2.json()) as { parent_id: string | null };
		expect(childPage.parent_id).toBeNull();
	});

	// --- get_prioritized_issues ---

	it("get_prioritized_issues returns empty list when no open issues", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as { issues: unknown[] };
		expect(Array.isArray(data.issues)).toBe(true);
		expect(data.issues).toHaveLength(0);
	});

	it("get_prioritized_issues returns issues with _score and _score_breakdown", async () => {
		const { user } = await seedFixture();
		await seedIssue(workspaceId, projectId, user.id, { title: "Issue A", priority: "high" });
		await seedIssue(workspaceId, projectId, user.id, { title: "Issue B", priority: "low" });

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as {
			issues: Array<{
				title: string;
				_score: number;
				_score_breakdown: { centrality: number; priority: number; story_points: number };
			}>;
		};
		expect(data.issues.length).toBeGreaterThan(0);
		for (const issue of data.issues) {
			expect(typeof issue._score).toBe("number");
			expect(issue._score_breakdown).toHaveProperty("centrality");
			expect(issue._score_breakdown).toHaveProperty("priority");
			expect(issue._score_breakdown).toHaveProperty("story_points");
		}
	});

	it("get_prioritized_issues ranks high-priority issues above low-priority", async () => {
		const { user } = await seedFixture();
		await seedIssue(workspaceId, projectId, user.id, { title: "Urgent", priority: "urgent" });
		await seedIssue(workspaceId, projectId, user.id, { title: "None", priority: "none" });

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as {
			issues: Array<{ title: string; _score: number }>;
		};
		const titles = data.issues.map((i) => i.title);
		expect(titles.indexOf("Urgent")).toBeLessThan(titles.indexOf("None"));
	});

	it("get_prioritized_issues excludes done and cancelled issues", async () => {
		const { user } = await seedFixture();
		await seedIssue(workspaceId, projectId, user.id, { title: "Open", priority: "high" });
		await seedIssue(workspaceId, projectId, user.id, {
			title: "Done",
			priority: "urgent",
			status: "done",
		});
		await seedIssue(workspaceId, projectId, user.id, {
			title: "Cancelled",
			priority: "urgent",
			status: "cancelled",
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as { issues: Array<{ title: string }> };
		const titles = data.issues.map((i) => i.title);
		expect(titles).toContain("Open");
		expect(titles).not.toContain("Done");
		expect(titles).not.toContain("Cancelled");
	});

	it("get_prioritized_issues respects limit parameter", async () => {
		const { user } = await seedFixture();
		for (let i = 0; i < 5; i++) {
			await seedIssue(workspaceId, projectId, user.id, { title: `Issue ${i}` });
		}

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { limit: 2, includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as { issues: unknown[] };
		expect(data.issues).toHaveLength(2);
	});

	it("get_prioritized_issues boosts issues with higher in-degree", async () => {
		const { user } = await seedFixture();
		const target = await seedIssue(workspaceId, projectId, user.id, {
			title: "Target",
			priority: "none",
		});
		const blocker = await seedIssue(workspaceId, projectId, user.id, {
			title: "Blocker",
			priority: "none",
		});

		// target is blocked by blocker → target gets in-degree 1
		await SELF.fetch(`http://localhost/api/issues/${blocker.id}/links`, {
			method: "POST",
			headers,
			body: JSON.stringify({ targetIssueId: target.id, type: "blocks" }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as {
			issues: Array<{ title: string; _score_breakdown: { centrality: number } }>;
		};
		const targetRow = data.issues.find((i) => i.title === "Target");
		const blockerRow = data.issues.find((i) => i.title === "Blocker");
		expect(targetRow?._score_breakdown.centrality).toBe(1);
		expect(blockerRow?._score_breakdown.centrality).toBe(0);
	});

	it("get_prioritized_issues uses story points custom field in scoring", async () => {
		const { user } = await seedFixture();
		const fieldDef = await seedCustomFieldDef(workspaceId, {
			key: "story_points",
			label: "Story Points",
			type: "number",
		});
		const small = await seedIssue(workspaceId, projectId, user.id, {
			title: "Small (1pt)",
			priority: "none",
		});
		const large = await seedIssue(workspaceId, projectId, user.id, {
			title: "Large (8pt)",
			priority: "none",
		});
		await seedCustomFieldValue(small.id, fieldDef.id, "1");
		await seedCustomFieldValue(large.id, fieldDef.id, "8");

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "get_prioritized_issues", arguments: { includeNotReady: true } },
			headers
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as {
			issues: Array<{ title: string; _score: number }>;
		};
		const smallRow = data.issues.find((i) => i.title === "Small (1pt)");
		const largeRow = data.issues.find((i) => i.title === "Large (8pt)");
		// Smaller story points → higher score (1/sp is larger for small sp)
		expect(smallRow!._score).toBeGreaterThan(largeRow!._score);
	});
});
