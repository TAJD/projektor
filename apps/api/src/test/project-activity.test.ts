import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedComment, seedIssue, seedProject, seedProjectFixture } from "./helpers";

type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };
type McpContent = { content: Array<{ text: string }> };

async function mcpCall<T>(
	workspaceId: string,
	toolName: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
	});
	return res.json();
}

function parseEvents(res: JsonRpcResult<McpContent> | JsonRpcError): unknown[] {
	if ("error" in res && res.error) {
		throw new Error(`MCP error: ${res.error.message}`);
	}
	const r = res as JsonRpcResult<McpContent>;
	return JSON.parse(r.result.content[0].text) as unknown[];
}

async function seedSprint(
	workspaceId: string,
	projectId: string,
	opts: { name?: string; status?: string; startDate?: number; endDate?: number } = {}
) {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO sprints (id, workspace_id, project_id, name, status, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspaceId,
			projectId,
			opts.name ?? "Sprint 1",
			opts.status ?? "planned",
			opts.startDate ?? null,
			opts.endDate ?? null,
			now,
			now
		)
		.run();
	return { id, name: opts.name ?? "Sprint 1" };
}

async function seedWikiPage(
	workspaceId: string,
	projectId: string,
	authorId: string,
	opts: { title?: string; slug?: string; updatedAt?: number } = {}
) {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const slug = opts.slug ?? (opts.title ?? "test-page").toLowerCase().replace(/\s+/g, "-");
	const updatedAt = opts.updatedAt ?? now;
	await env.DB.prepare(
		`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content, created_by_id, updated_by_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspaceId,
			projectId,
			slug,
			opts.title ?? "Test Page",
			authorId,
			authorId,
			now,
			updatedAt
		)
		.run();
	return { id, slug };
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("list_project_activity MCP tool", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;
	let headers: Record<string, string>;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		headers = authHeaders(token, slug);
	});

	it("returns empty array when project has no activity", async () => {
		const res = await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		);
		const events = parseEvents(res);
		expect(Array.isArray(events)).toBe(true);
		expect(events).toHaveLength(0);
	});

	it("returns issue_created events", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "My Issue" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			type: string;
			summary: string;
			entity_type: string;
			entity_ref: string;
			created_at: number;
		}>;

		const created = events.filter((e) => e.type === "issue_created");
		expect(created).toHaveLength(1);
		expect(created[0].summary).toBe("My Issue");
		expect(created[0].entity_type).toBe("issue");
		expect(created[0].entity_ref).toMatch(/^PROJ-\d+$/);
		expect(typeof created[0].created_at).toBe("number");
	});

	it("returns issue_commented events", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId);
		await seedComment(issue.id, userId, "Hello world");

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			type: string;
			actor: string | null;
		}>;

		const commented = events.filter((e) => e.type === "issue_commented");
		expect(commented).toHaveLength(1);
		expect(commented[0].actor).toBe(userId);
	});

	it("returns wiki_page_created events", async () => {
		await seedWikiPage(workspaceId, projectId, userId, { title: "Design Doc" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			type: string;
			entity_type: string;
			summary: string;
			entity_ref: string;
		}>;

		const wikiCreated = events.filter((e) => e.type === "wiki_page_created");
		expect(wikiCreated).toHaveLength(1);
		expect(wikiCreated[0].summary).toBe("Design Doc");
		expect(wikiCreated[0].entity_type).toBe("wiki_page");
		expect(wikiCreated[0].entity_ref).toBe("design-doc");
	});

	it("returns wiki_page_edited events when updated_at differs from created_at", async () => {
		await seedWikiPage(workspaceId, projectId, userId, {
			title: "Edited Doc",
			updatedAt: Math.floor(Date.now() / 1000) + 10,
		});

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{ type: string }>;

		const edited = events.filter((e) => e.type === "wiki_page_edited");
		expect(edited).toHaveLength(1);
	});

	it("does not return wiki_page_edited when page was never updated", async () => {
		await seedWikiPage(workspaceId, projectId, userId, { title: "Untouched" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{ type: string }>;

		const edited = events.filter((e) => e.type === "wiki_page_edited");
		expect(edited).toHaveLength(0);
	});

	it("returns sprint_started events for active sprints with a start_date", async () => {
		const now = Math.floor(Date.now() / 1000);
		await seedSprint(workspaceId, projectId, {
			name: "Sprint Alpha",
			status: "active",
			startDate: now,
		});

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			type: string;
			summary: string;
			entity_type: string;
		}>;

		const started = events.filter((e) => e.type === "sprint_started");
		expect(started).toHaveLength(1);
		expect(started[0].summary).toContain("Sprint Alpha");
		expect(started[0].entity_type).toBe("sprint");
	});

	it("returns sprint_completed events for completed sprints", async () => {
		const now = Math.floor(Date.now() / 1000);
		await seedSprint(workspaceId, projectId, {
			name: "Sprint Beta",
			status: "completed",
			startDate: now - 100,
			endDate: now,
		});

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			type: string;
			summary: string;
		}>;

		const completed = events.filter((e) => e.type === "sprint_completed");
		expect(completed).toHaveLength(1);
		expect(completed[0].summary).toContain("Sprint Beta");

		const started = events.filter((e) => e.type === "sprint_started");
		expect(started).toHaveLength(1);
	});

	it("respects the limit parameter", async () => {
		for (let i = 0; i < 5; i++) {
			await seedIssue(workspaceId, projectId, userId, { title: `Issue ${i}` });
		}

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId, limit: 2 },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as unknown[];
		expect(events).toHaveLength(2);
	});

	it("respects the since filter", async () => {
		const past = Math.floor(Date.now() / 1000) - 3600;
		await seedIssue(workspaceId, projectId, userId, { title: "Old issue", createdAt: past - 1 });
		await seedIssue(workspaceId, projectId, userId, { title: "New issue" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId, since: past },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{ summary: string }>;

		const titles = events.map((e) => e.summary);
		expect(titles).toContain("New issue");
		expect(titles).not.toContain("Old issue");
	});

	it("returns events ordered most-recent first", async () => {
		const base = Math.floor(Date.now() / 1000) - 100;
		await seedIssue(workspaceId, projectId, userId, { title: "Older", createdAt: base });
		await seedIssue(workspaceId, projectId, userId, { title: "Newer", createdAt: base + 50 });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{
			summary: string;
			created_at: number;
		}>;

		const created = events.filter((e) => e.summary === "Older" || e.summary === "Newer");
		expect(created[0].summary).toBe("Newer");
		expect(created[1].summary).toBe("Older");
	});

	it("scopes events to the given project and not other projects", async () => {
		const other = await seedProject(workspaceId, "OTHER");
		await seedIssue(workspaceId, other.id, userId, { title: "Other project issue" });
		await seedIssue(workspaceId, projectId, userId, { title: "This project issue" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<{ summary: string }>;

		const summaries = events.map((e) => e.summary);
		expect(summaries).toContain("This project issue");
		expect(summaries).not.toContain("Other project issue");
	});

	it("returns error for unknown project", async () => {
		const res = (await mcpCall(
			workspaceId,
			"list_project_activity",
			{ projectId: crypto.randomUUID() },
			headers
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
		expect(res.error.message).toMatch(/not found/i);
	});

	it("returns error when projectId is missing", async () => {
		const res = (await mcpCall(workspaceId, "list_project_activity", {}, headers)) as JsonRpcError;
		expect(res.error).toBeDefined();
	});

	it("response shape is flat (no nested objects)", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Flat check" });

		const res = (await mcpCall<McpContent>(
			workspaceId,
			"list_project_activity",
			{ projectId },
			headers
		)) as JsonRpcResult<McpContent>;
		const events = JSON.parse(res.result.content[0].text) as Array<Record<string, unknown>>;

		for (const event of events) {
			for (const val of Object.values(event)) {
				expect(typeof val === "object" && val !== null && !Array.isArray(val)).toBe(false);
			}
		}
	});
});

describe("GET /api/projects/:id/activity (PROJ-245)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;
	let headers: Record<string, string>;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		headers = authHeaders(token, slug);
	});

	it("returns empty array when project has no activity", async () => {
		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/activity`, {
			headers,
		});
		expect(res.status).toBe(200);
		const events = (await res.json()) as unknown[];
		expect(events).toEqual([]);
	});

	it("returns issue_created events, matching the MCP tool's behavior", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "REST activity issue" });

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/activity`, {
			headers,
		});
		expect(res.status).toBe(200);
		const events = (await res.json()) as Array<{ type: string; summary: string }>;
		const created = events.filter((e) => e.type === "issue_created");
		expect(created).toHaveLength(1);
		expect(created[0].summary).toBe("REST activity issue");
	});

	it("respects the limit query param", async () => {
		for (let i = 0; i < 5; i++) {
			await seedIssue(workspaceId, projectId, userId, { title: `Issue ${i}` });
		}

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/activity?limit=2`, {
			headers,
		});
		const events = (await res.json()) as unknown[];
		expect(events).toHaveLength(2);
	});

	it("returns 404 for an unknown project", async () => {
		const res = await SELF.fetch(`http://localhost/api/projects/${crypto.randomUUID()}/activity`, {
			headers,
		});
		expect(res.status).toBe(404);
	});
});
