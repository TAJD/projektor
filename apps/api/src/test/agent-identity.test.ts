// PROJ-894: stateless agent identity. register_agent records the credential that made the
// call; claim_issue / heartbeat_agent / end_agent may then omit the agent id when that
// credential owns exactly one (live) session, and must pass it otherwise.

import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken, seedIssue, seedProjectFixture, seedToken } from "./helpers";

type RpcBody = {
	result?: { content?: Array<{ text: string }>; isError?: boolean };
	error?: { code: number; message: string; data?: unknown };
};

describe("PROJ-894: stateless agent identity", () => {
	let token: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	// These tests make more calls per token than wrangler.test.toml's RATE_LIMIT_API_MAX.
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "1000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	beforeEach(async () => {
		({ token, workspaceId, projectId, userId } = await seedProjectFixture());
	});

	async function call(
		bearer: string,
		name: string,
		args: Record<string, unknown>
	): Promise<{ ok: boolean; value: Record<string, unknown>; message: string }> {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const body = (await res.json()) as RpcBody;
		// A failure is either a JSON-RPC error or (PROJ-893) an isError tool result;
		// this suite is about identity resolution, not the error envelope.
		if (body.error)
			return { ok: false, value: {}, message: body.error.message ?? JSON.stringify(body) };
		const text = body.result?.content?.[0]?.text ?? "";
		if (body.result?.isError) return { ok: false, value: {}, message: text };
		return { ok: true, value: JSON.parse(text) as Record<string, unknown>, message: "" };
	}

	async function credentialIdOf(bearer: string): Promise<string> {
		const row = await env.DB.prepare("SELECT id FROM api_tokens WHERE token_hash = ?")
			.bind(await hashToken(bearer))
			.first<{ id: string }>();
		if (!row) throw new Error("token row missing");
		return row.id;
	}

	async function register(bearer = token, name = "agent"): Promise<string> {
		const r = await call(bearer, "register_agent", { name });
		expect(r.ok).toBe(true);
		return r.value.id as string;
	}

	it("register_agent records the credential and auth method on the session", async () => {
		const id = await register();
		const row = await env.DB.prepare(
			"SELECT auth_method, credential_id, token_id FROM agent_sessions WHERE id = ?"
		)
			.bind(id)
			.first<{ auth_method: string; credential_id: string; token_id: string }>();
		const credentialId = await credentialIdOf(token);
		// seedToken mints a `tok_` token, which the auth middleware classifies as a PAT.
		expect(row).toEqual({
			auth_method: "pat",
			credential_id: credentialId,
			token_id: credentialId,
		});
	});

	it("one live session: claim_issue, heartbeat_agent and end_agent work without an agent id", async () => {
		const sessionId = await register();
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Claim me" });

		const claim = await call(token, "claim_issue", { issueId: issue.id });
		expect(claim.ok).toBe(true);
		expect(claim.value.agentSessionId).toBe(sessionId);

		const beat = await call(token, "heartbeat_agent", {});
		expect(beat.ok).toBe(true);
		expect(beat.value.id).toBe(sessionId);

		const end = await call(token, "end_agent", {});
		expect(end.ok).toBe(true);
		expect(end.value.status).toBe("ended");
	});

	it("two sessions on a shared token: an omitted id is rejected with a hint, an explicit id works", async () => {
		const a = await register(token, "agent-a");
		await register(token, "agent-b");
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Contended" });

		for (const [tool, args] of [
			["claim_issue", { issueId: issue.id }],
			["heartbeat_agent", {}],
			["end_agent", {}],
		] as const) {
			const r = await call(token, tool, { ...args });
			expect(r.ok, tool).toBe(false);
			expect(r.message, tool).toContain("pass agentId from register_agent");
		}

		const claim = await call(token, "claim_issue", { issueId: issue.id, agentId: a });
		expect(claim.ok).toBe(true);
		expect(claim.value.agentSessionId).toBe(a);
	});

	it("no session on the credential: an omitted id is rejected, even if another credential has one", async () => {
		await register(token, "owner-of-a-session");
		const other = await seedToken(workspaceId, userId);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Not yours" });

		const r = await call(other, "claim_issue", { issueId: issue.id });
		expect(r.ok).toBe(false);
		expect(r.message).toContain("pass agentId from register_agent");

		// A different credential's session is never picked up by mistake.
		const beat = await call(other, "heartbeat_agent", {});
		expect(beat.ok).toBe(false);
	});

	it("an ended session no longer counts, so a fresh register_agent becomes the single session again", async () => {
		const first = await register(token, "first");
		expect((await call(token, "end_agent", {})).ok).toBe(true);
		const second = await register(token, "second");

		const beat = await call(token, "heartbeat_agent", {});
		expect(beat.ok).toBe(true);
		expect(beat.value.id).toBe(second);
		expect(second).not.toBe(first);
	});

	it("a stale session can be revived by an id-less heartbeat, but cannot claim until then", async () => {
		const sessionId = await register();
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Stale claim" });
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 600, sessionId)
			.run();

		const claim = await call(token, "claim_issue", { issueId: issue.id });
		expect(claim.ok).toBe(false);

		const beat = await call(token, "heartbeat_agent", {});
		expect(beat.ok).toBe(true);
		expect(beat.value.id).toBe(sessionId);

		expect((await call(token, "claim_issue", { issueId: issue.id })).ok).toBe(true);
	});

	it("an explicit id still works exactly as before", async () => {
		const sessionId = await register();
		const beat = await call(token, "heartbeat_agent", { id: sessionId });
		expect(beat.ok).toBe(true);
		expect(beat.value.id).toBe(sessionId);
	});
});
