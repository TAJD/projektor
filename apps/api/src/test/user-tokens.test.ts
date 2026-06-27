/**
 * PROJ-91 — User-scoped API tokens
 *
 * Coverage:
 *  1. User-scoped token can read+write in a workspace the user IS a member of.
 *  2. User-scoped token is rejected (403) for a workspace the user is NOT a member of.
 *  3. Workspace-scoped token is still confined to its workspace (regression).
 *  4. POST /auth/tokens without workspaceId mints a user-scoped token (NULL in DB).
 */

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedMember,
	seedProject,
	seedUser,
	seedUserToken,
	seedWorkspace,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getIssues(token: string, slug: string) {
	return SELF.fetch("http://localhost/api/issues", { headers: authHeaders(token, slug) });
}

async function postIssue(token: string, slug: string, projectId: string, title: string) {
	return SELF.fetch("http://localhost/api/issues", {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({ projectId, title }),
	});
}

// ---------------------------------------------------------------------------
// §1: User-scoped token access for member workspaces
// ---------------------------------------------------------------------------

describe("PROJ-91: user-scoped token — member workspace", () => {
	let slug: string;
	let userId: string;
	let userToken: string;
	let projectId: string;

	beforeEach(async () => {
		const ws = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);
		slug = ws.slug;
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		userId = user.id;
		await seedMember(ws.id, userId, "member");
		userToken = await seedUserToken(userId);
		projectId = (await seedProject(ws.id)).id;
	});

	it("can read issues in a workspace the user is a member of", async () => {
		const res = await getIssues(userToken, slug);
		expect(res.status).toBe(200);
	});

	it("can write (create issue) in a workspace the user is a member of", async () => {
		const res = await postIssue(userToken, slug, projectId, "user-token write test");
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBeTruthy();
	});

	it("works across multiple workspaces the user belongs to", async () => {
		const ws2 = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);
		await seedMember(ws2.id, userId, "viewer");

		// Same user-scoped token, different workspace
		const res = await getIssues(userToken, ws2.slug);
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// §2: User-scoped token rejected for non-member workspaces
// ---------------------------------------------------------------------------

describe("PROJ-91: user-scoped token — non-member workspace", () => {
	it("returns 403 when user is not a member of the target workspace", async () => {
		const ws1 = await seedWorkspace(`ws1-${crypto.randomUUID().slice(0, 8)}`);
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(ws1.id, user.id, "member");
		const userToken = await seedUserToken(user.id);

		// ws2: user has NO membership
		const ws2 = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);

		const res = await getIssues(userToken, ws2.slug);
		expect(res.status).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// §3: Workspace-scoped token regression — still confined to its workspace
// ---------------------------------------------------------------------------

describe("PROJ-91: workspace-scoped token regression", () => {
	it("workspace-scoped token is blocked from a different workspace even if user is a member", async () => {
		const fixture = await seedFixture(); // token is scoped to fixture.workspace

		// Add the same user to a second workspace
		const ws2 = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);
		await seedMember(ws2.id, fixture.user.id, "member");

		// Use the ws1-scoped token to access ws2 → must be 403
		const res = await getIssues(fixture.token, ws2.slug);
		expect(res.status).toBe(403);
	});

	it("workspace-scoped token still works in its own workspace", async () => {
		const fixture = await seedFixture();
		const res = await getIssues(fixture.token, fixture.workspace.slug);
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// §4: Minting user-scoped tokens via POST /auth/tokens
// ---------------------------------------------------------------------------

describe("PROJ-91: POST /auth/tokens — user-scoped minting", () => {
	it("omitting workspaceId creates a token with null workspace_id", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "my-user-token", scopes: ["read", "write"] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");

		// Verify the DB row has null workspace_id
		const row = await env.DB.prepare(
			"SELECT workspace_id FROM api_tokens WHERE name = ? AND user_id = ?"
		)
			.bind("my-user-token", fixture.user.id)
			.first<{ workspace_id: string | null }>();
		expect(row).not.toBeNull();
		expect(row?.workspace_id).toBeNull();
	});

	it("minted user-scoped token can authenticate against the user's workspace", async () => {
		const fixture = await seedFixture();

		// Mint via API
		const mintRes = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "cross-ws-token", scopes: ["*"] }),
		});
		expect(mintRes.status).toBe(201);
		const { token: newToken } = (await mintRes.json()) as { token: string };

		// Use it against the user's workspace
		const res = await getIssues(newToken, fixture.workspace.slug);
		expect(res.status).toBe(200);
	});

	it("providing workspaceId still creates a workspace-scoped token (existing behaviour)", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: "ws-scoped",
				workspaceId: fixture.workspace.id,
				scopes: ["read"],
			}),
		});
		expect(res.status).toBe(201);

		const row = await env.DB.prepare(
			"SELECT workspace_id FROM api_tokens WHERE name = ? AND user_id = ?"
		)
			.bind("ws-scoped", fixture.user.id)
			.first<{ workspace_id: string | null }>();
		expect(row?.workspace_id).toBe(fixture.workspace.id);
	});
});
