// PROJ-889: MCP calls get the full ServiceCtx (realtime hub, waitUntil) and every auth
// strategy records its method + credential on the request context.

import { env, SELF } from "cloudflare:test";
import type { AuthInfo, HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../middleware/auth";
import { hashToken, seedFixture, seedIssueFixture, seedUserToken } from "./helpers";

describe("PROJ-889: MCP mutations broadcast like REST", () => {
	const prevHub = env.WORKSPACE_HUB;
	afterEach(() => {
		env.WORKSPACE_HUB = prevHub;
	});

	it("add_comment over MCP posts a realtime event to the workspace hub", async () => {
		const f = await seedIssueFixture();
		const broadcasts: Array<{ url: string; body: string }> = [];
		env.WORKSPACE_HUB = {
			idFromName: (name: string) => ({ name }),
			get: () => ({
				fetch: async (url: string, init?: RequestInit) => {
					broadcasts.push({ url, body: String(init?.body ?? "") });
					return new Response("ok");
				},
			}),
		} as unknown as DurableObjectNamespace;

		const res = await SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "add_comment", arguments: { issueId: f.issueId, body: "hi" } },
			}),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();

		expect(broadcasts.length).toBeGreaterThan(0);
		expect(broadcasts[0].url).toMatch(/\/broadcast$/);
		expect(JSON.parse(broadcasts[0].body)).toMatchObject({ workspaceId: f.workspaceId });
	});
});

describe("PROJ-889: auth middleware records method + credential", () => {
	const app = new Hono<HonoEnv>();
	app.use("*", authMiddleware);
	app.get("/whoami", (c) => c.json(c.get("auth")));

	async function whoami(headers: Record<string, string> = {}): Promise<AuthInfo> {
		const res = await app.request("/whoami", { headers }, env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		return (await res.json()) as AuthInfo;
	}

	const prevDev = env.DEV_USER_EMAIL;
	afterEach(() => {
		env.DEV_USER_EMAIL = prevDev;
	});

	it("a pk_ workspace token → method pk, with its api_tokens id and scopes", async () => {
		const { workspace, user } = await seedFixture();
		const raw = `pk_${crypto.randomUUID().replace(/-/g, "")}`;
		const id = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, created_at)
			 VALUES (?, ?, ?, 'pk', ?, '["read"]', ?)`
		)
			.bind(id, workspace.id, user.id, await hashToken(raw), Math.floor(Date.now() / 1000))
			.run();

		const auth = await whoami({ Authorization: `Bearer ${raw}` });
		expect(auth).toMatchObject({ kind: "agent", method: "pk", credentialId: id });
		expect(auth.scopes).toContain("read");
	});

	it("a personal access token → method pat", async () => {
		const { user } = await seedFixture();
		const pat = await seedUserToken(user.id);
		const auth = await whoami({ Authorization: `Bearer ${pat}` });
		expect(auth.kind).toBe("agent");
		expect(auth.method).toBe("pat");
		expect(typeof auth.credentialId).toBe("string");
	});

	it("the dev bypass → method dev", async () => {
		const { user } = await seedFixture();
		env.DEV_USER_EMAIL = user.email;
		expect(await whoami()).toEqual({ kind: "human", method: "dev" });
	});
});
