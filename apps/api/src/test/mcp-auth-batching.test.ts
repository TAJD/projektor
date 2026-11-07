import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginRegistry } from "../plugins/registry";
import {
	authHeaders,
	hashToken,
	seedFixture,
	seedIssue,
	seedMember,
	seedProjectFixture,
	seedToken,
	seedUser,
	seedWorkspace,
} from "./helpers";
import { resetRateLimits, seedRateLimitCounter } from "./rate-limit-reset";

function trackD1RoundTrips() {
	let count = 0;
	const origPrepare = env.DB.prepare.bind(env.DB);
	const origBatch = env.DB.batch.bind(env.DB);
	const EXEC_METHODS = new Set(["run", "all", "get", "first", "raw"]);

	const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...args: unknown[]) =>
						wrapStmt((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
				}
				if (typeof prop === "string" && EXEC_METHODS.has(prop)) {
					return (...args: unknown[]) => {
						count++;
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			},
		});

	vi.spyOn(env.DB, "prepare").mockImplementation(
		(q: string) => wrapStmt(origPrepare(q)) as D1PreparedStatement
	);
	vi.spyOn(env.DB, "batch").mockImplementation((stmts: D1PreparedStatement[]) => {
		count++;
		return origBatch(stmts);
	});

	return { count: () => count };
}

let atHandler: { d1: number; digests: number } | undefined;
let currentD1: () => number = () => 0;
let currentDigests: () => number = () => 0;

pluginRegistry.register({
	id: "proj-1016-probe",
	name: "probe",
	version: "0.0.0",
	mcpTools: [
		{
			name: "probe_pre_handler",
			description: "records D1 round trips and digests seen before the handler started",
			inputSchema: { type: "object", properties: {} },
			handler: async () => {
				atHandler = { d1: currentD1(), digests: currentDigests() };
				return { ok: true };
			},
		},
	],
});

function mcpCall(workspaceId: string, token: string, name: string, args: unknown = {}) {
	return SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

async function warmLastUsedAt(workspaceId: string, token: string) {
	const res = await mcpCall(workspaceId, token, "probe_pre_handler");
	expect(res.status).toBe(200);
}

async function measureProbe(workspaceId: string, token: string) {
	atHandler = undefined;
	const tracker = trackD1RoundTrips();
	currentD1 = tracker.count;
	const origDigest = crypto.subtle.digest.bind(crypto.subtle);
	let digests = 0;
	vi.spyOn(crypto.subtle, "digest").mockImplementation((...args) => {
		digests++;
		return origDigest(...(args as Parameters<typeof origDigest>));
	});
	currentDigests = () => digests;
	const res = await mcpCall(workspaceId, token, "probe_pre_handler");
	vi.restoreAllMocks();
	return { res, seen: probeResult() };
}

function probeResult() {
	return atHandler;
}

describe("PROJ-1016: MCP auth path", () => {
	beforeEach(async () => {
		await resetRateLimits();
	});
	afterEach(() => vi.restoreAllMocks());

	it("resolves token, user, workspace and membership in one D1 round trip", async () => {
		const f = await seedFixture({ role: "member" });
		pluginRegistry.enableForWorkspace(f.workspace.id, "proj-1016-probe");
		await warmLastUsedAt(f.workspace.id, f.token);

		const { res, seen } = await measureProbe(f.workspace.id, f.token);

		expect(res.status).toBe(200);
		expect(seen?.d1).toBe(1);
	});

	it("hashes the bearer token once per request", async () => {
		const f = await seedFixture({ role: "member" });
		pluginRegistry.enableForWorkspace(f.workspace.id, "proj-1016-probe");
		await warmLastUsedAt(f.workspace.id, f.token);

		const { seen } = await measureProbe(f.workspace.id, f.token);

		expect(seen?.digests).toBe(1);
	});

	it("get_issue works through the combined lookup", async () => {
		const f = await seedProjectFixture({ role: "member" });
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Auth path" });

		const res = await mcpCall(f.workspaceId, f.token, "get_issue", { id: issue.id });
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };

		expect(res.status).toBe(200);
		expect(JSON.parse(body.result.content[0].text)).toMatchObject({ id: issue.id });
	});

	it("a token confined to another workspace is 403, even for a member of the target", async () => {
		const a = await seedFixture({ role: "member" });
		const b = await seedWorkspace();
		await seedMember(b.id, a.user.id, "member");

		const res = await mcpCall(b.id, a.token, "probe_pre_handler");

		expect(res.status).toBe(403);
	});

	it("a user-scoped token works in a workspace the user belongs to and is 403 elsewhere", async () => {
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		const member = await seedWorkspace();
		const other = await seedWorkspace();
		await seedMember(member.id, user.id, "member");
		const token = await seedToken(member.id, user.id);
		await env.DB.prepare("UPDATE api_tokens SET workspace_id = NULL WHERE user_id = ?")
			.bind(user.id)
			.run();
		pluginRegistry.enableForWorkspace(member.id, "proj-1016-probe");

		expect((await mcpCall(member.id, token, "probe_pre_handler")).status).toBe(200);
		expect((await mcpCall(other.id, token, "probe_pre_handler")).status).toBe(403);
	});

	it("an unknown workspace is 404", async () => {
		const f = await seedFixture({ role: "member" });
		await env.DB.prepare("UPDATE api_tokens SET workspace_id = NULL WHERE user_id = ?")
			.bind(f.user.id)
			.run();

		const res = await mcpCall(crypto.randomUUID(), f.token, "probe_pre_handler");

		expect(res.status).toBe(404);
	});

	it("a revoked membership takes effect on the next request", async () => {
		const f = await seedFixture({ role: "member" });
		pluginRegistry.enableForWorkspace(f.workspace.id, "proj-1016-probe");
		expect((await mcpCall(f.workspace.id, f.token, "probe_pre_handler")).status).toBe(200);

		await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(f.workspace.id, f.user.id)
			.run();

		expect((await mcpCall(f.workspace.id, f.token, "probe_pre_handler")).status).toBe(403);
	});

	it("an X-Workspace-Slug header still wins over the path workspace", async () => {
		const f = await seedFixture({ role: "member" });
		const other = await seedWorkspace();
		await seedMember(other.id, f.user.id, "member");
		await env.DB.prepare("UPDATE api_tokens SET workspace_id = NULL WHERE user_id = ?")
			.bind(f.user.id)
			.run();

		const res = await SELF.fetch(`http://localhost/mcp/${f.workspace.id}`, {
			method: "POST",
			headers: {
				...authHeaders(f.token, other.slug),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

		expect(res.status).toBe(200);
	});
});

describe("PROJ-1016: rate limiter runs alongside the auth lookup", () => {
	beforeEach(async () => {
		await resetRateLimits();
	});
	afterEach(() => vi.restoreAllMocks());

	it("an over-limit caller is 429 and its tool handler never runs", async () => {
		const f = await seedFixture({ role: "member" });
		pluginRegistry.enableForWorkspace(f.workspace.id, "proj-1016-probe");
		await seedRateLimitCounter(`tok:${(await hashToken(f.token)).slice(0, 16)}`, 5);
		atHandler = undefined;

		const res = await mcpCall(f.workspace.id, f.token, "probe_pre_handler");

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBeTruthy();
		expect(atHandler).toBeUndefined();
	});

	it("an over-limit caller with a bad token is 429, not 401", async () => {
		const f = await seedFixture({ role: "member" });
		const bad = "tok_not-a-real-token";
		await seedRateLimitCounter(`tok:${(await hashToken(bad)).slice(0, 16)}`, 5);

		const res = await mcpCall(f.workspace.id, bad, "probe_pre_handler");

		expect(res.status).toBe(429);
	});

	it("fails open when the limiter is unavailable", async () => {
		const f = await seedFixture({ role: "member" });
		pluginRegistry.enableForWorkspace(f.workspace.id, "proj-1016-probe");
		vi.spyOn(console, "error").mockImplementation(() => {});
		const saved = env.RATE_LIMITER;
		env.RATE_LIMITER = {
			idFromName: () => {
				throw new Error("limiter down");
			},
			get: () => {
				throw new Error("limiter down");
			},
		} as unknown as typeof env.RATE_LIMITER;

		const res = await mcpCall(f.workspace.id, f.token, "probe_pre_handler");
		env.RATE_LIMITER = saved;

		expect(res.status).toBe(200);
	});
});
