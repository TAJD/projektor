import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedComment,
	seedFixture,
	seedGroupGrant,
	seedProject,
	seedProjectFixture,
} from "./helpers";

type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

async function mcpCall<T>(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json();
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Comments REST API", () => {
	let token: string;
	let slug: string;
	let userId: string;
	let issueId: string;

	beforeEach(async () => {
		const fixture = await seedProjectFixture();
		({ token, slug, userId } = fixture);

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId: fixture.projectId, title: "Issue with comments" }),
		});
		const body = (await res.json()) as { id: string };
		issueId = body.id;
	});

	it("GET /:issueId/comments returns empty list", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()) as unknown[];
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(0);
	});

	it("POST /:issueId/comments creates a comment", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "Hello world" }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as { id: string };
		expect(data.id).toBeTruthy();
	});

	// PROJ-328: author_kind is stamped from the authenticated principal type, not a
	// caller-supplied field. Tests authenticate over Bearer tokens (see authHeaders),
	// same as agents — see middleware/auth.ts / conventions.md for the human/agent split.
	it("stamps author_kind from the auth transport, not a caller-supplied field", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "Hello world", authorKind: "human" }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as { id: string };

		const row = await env.DB.prepare("SELECT author_kind FROM issue_comments WHERE id = ?")
			.bind(data.id)
			.first<{ author_kind: string | null }>();
		expect(row?.author_kind).toBe("agent");
	});

	it("GET after POST returns the comment", async () => {
		await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "First comment" }),
		});

		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			headers: authHeaders(token, slug),
		});
		const data = (await res.json()) as Array<{ body: string }>;
		expect(data).toHaveLength(1);
		expect(data[0].body).toBe("First comment");
	});

	it("POST rejects body that exceeds 10000 chars", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "x".repeat(10001) }),
		});
		expect(res.status).toBe(400);
	});

	it("POST rejects empty body", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("GET returns 404 for issue in another workspace", async () => {
		const other = await seedFixture();
		// issueId belongs to the first workspace; use other workspace's token+slug
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH updates own comment", async () => {
		const comment = await seedComment(issueId, userId);

		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments/${comment.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "Updated text" }),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			headers: authHeaders(token, slug),
		});
		const data = (await listRes.json()) as Array<{ body: string }>;
		expect(data[0].body).toBe("Updated text");
	});

	it("PATCH returns 403 when editing another user's comment", async () => {
		const other = await seedFixture();
		// Seed a comment by a different user on the same issue (cross-user test within same ws)
		const comment = await seedComment(issueId, other.user.id);

		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments/${comment.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ body: "Hijacked" }),
		});
		expect(res.status).toBe(403);
	});

	it("DELETE removes own comment", async () => {
		const comment = await seedComment(issueId, userId);

		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments/${comment.id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/comments`, {
			headers: authHeaders(token, slug),
		});
		const data = (await listRes.json()) as unknown[];
		expect(data).toHaveLength(0);
	});
});

describe("Comments MCP cross-workspace security", () => {
	it("MCP add_comment rejects issueId belonging to another workspace", async () => {
		const wsA = await seedFixture({ slug: `ws-a-${crypto.randomUUID().slice(0, 6)}` });
		const wsB = await seedFixture({ slug: `ws-b-${crypto.randomUUID().slice(0, 6)}` });
		const projB = await seedProject(wsB.workspace.id, "VIC");
		await seedGroupGrant(wsB.workspace.id, wsB.user.id, projB.id);

		const issueRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(wsB.token, wsB.workspace.slug),
			body: JSON.stringify({ projectId: projB.id, title: "Secret issue" }),
		});
		const { id: victimIssueId } = (await issueRes.json()) as { id: string };

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			wsA.workspace.id,
			"tools/call",
			{ name: "add_comment", arguments: { issueId: victimIssueId, body: "Injected comment" } },
			authHeaders(wsA.token, wsA.workspace.slug)
		)) as JsonRpcError;

		expect(res.error).toBeDefined();
		expect(res.error.code).toBe(-32000);
	});

	it("MCP list_comments rejects issueId belonging to another workspace", async () => {
		const wsA = await seedFixture({ slug: `ws-c-${crypto.randomUUID().slice(0, 6)}` });
		const wsB = await seedFixture({ slug: `ws-d-${crypto.randomUUID().slice(0, 6)}` });
		const projB = await seedProject(wsB.workspace.id, "SEC");
		await seedGroupGrant(wsB.workspace.id, wsB.user.id, projB.id);

		const issueRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(wsB.token, wsB.workspace.slug),
			body: JSON.stringify({ projectId: projB.id, title: "Private issue" }),
		});
		const { id: victimIssueId } = (await issueRes.json()) as { id: string };

		// Add a comment so there's something to leak if scoping breaks
		await SELF.fetch(`http://localhost/api/issues/${victimIssueId}/comments`, {
			method: "POST",
			headers: authHeaders(wsB.token, wsB.workspace.slug),
			body: JSON.stringify({ body: "Secret comment content" }),
		});

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			wsA.workspace.id,
			"tools/call",
			{ name: "list_comments", arguments: { issueId: victimIssueId } },
			authHeaders(wsA.token, wsA.workspace.slug)
		)) as JsonRpcError;

		expect(res.error).toBeDefined();
		expect(res.error.code).toBe(-32000);
	});
});
