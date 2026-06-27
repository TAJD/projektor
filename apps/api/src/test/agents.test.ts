import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedIssue, seedProject } from "./helpers";

describe("Agents API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
	});

	async function registerAgent(body: Record<string, unknown>) {
		return SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	// A1: register -> active, appears in list_active_agents by issueId
	it("A1: POST /api/agents registers a session and it appears in GET list filtered by issueId", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Test Issue" });

		const res = await registerAgent({ name: "test-agent", issueId: issue.id });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string; status: string; kind: string };
		expect(session.id).toBeTruthy();
		expect(session.status).toBe("active");
		expect(session.kind).toBe("agent");

		const listRes = await SELF.fetch(`http://localhost/api/agents?issueId=${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(listRes.status).toBe(200);
		const body = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(body.items.some((s) => s.id === session.id)).toBe(true);
	});

	// A2: heartbeat bumps last_heartbeat_at; stale session excluded from list
	it("A2: heartbeat updates last_heartbeat_at; stale session is excluded from list", async () => {
		const res = await registerAgent({ name: "heartbeat-agent" });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string };

		// Heartbeat should succeed
		const hbRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/heartbeat`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(hbRes.status).toBe(200);
		const updated = (await hbRes.json()) as { lastHeartbeatAt: number };
		expect(typeof updated.lastHeartbeatAt).toBe("number");

		// Backdate the heartbeat to simulate staleness (> 120s ago)
		const stale = Math.floor(Date.now() / 1000) - 200;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(stale, session.id)
			.run();

		// Should now be excluded from active list
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);
	});

	// A3: end -> status='ended', excluded from active list
	it("A3: POST /:id/end sets status=ended and excludes session from active list", async () => {
		const res = await registerAgent({ name: "end-agent" });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string };

		const endRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(endRes.status).toBe(200);
		const ended = (await endRes.json()) as { status: string; endedAt: number | null };
		expect(ended.status).toBe("ended");
		expect(ended.endedAt).toBeGreaterThan(0);

		// Must not appear in active list
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);
	});

	// A4: default kind is 'agent'; kind='human' is distinguishable in list output
	it("A4: default kind is agent; human kind is distinguishable in list", async () => {
		const agentRes = await registerAgent({ name: "bot" });
		const agentSession = (await agentRes.json()) as { id: string; kind: string };
		expect(agentSession.kind).toBe("agent");

		const humanRes = await registerAgent({ name: "human-user", kind: "human" });
		expect(humanRes.status).toBe(201);
		const humanSession = (await humanRes.json()) as { id: string; kind: string };
		expect(humanSession.kind).toBe("human");

		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const listBody = (await listRes.json()) as { items: Array<{ id: string; kind: string }> };
		const agentItem = listBody.items.find((s) => s.id === agentSession.id);
		const humanItem = listBody.items.find((s) => s.id === humanSession.id);
		expect(agentItem?.kind).toBe("agent");
		expect(humanItem?.kind).toBe("human");
	});

	// A5: tenant isolation
	it("A5: session in workspace X is not visible from workspace Y; heartbeat/end from Y -> 404", async () => {
		const other = await seedFixture();

		// Register session in our workspace (X)
		const res = await registerAgent({ name: "isolated-agent" });
		const session = (await res.json()) as { id: string };

		// Workspace Y should not see it
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);

		// Heartbeat from Y -> 404
		const hbRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/heartbeat`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(hbRes.status).toBe(404);

		// End from Y -> 404
		const endRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/end`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(endRes.status).toBe(404);
	});

	it("POST /api/agents returns 400 for missing name", async () => {
		const res = await registerAgent({});
		expect(res.status).toBe(400);
	});

	it("POST /api/agents returns 404 for unknown issueId", async () => {
		const res = await registerAgent({ name: "orphan", issueId: crypto.randomUUID() });
		expect(res.status).toBe(404);
	});

	it("POST /:id/heartbeat returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/agents/${crypto.randomUUID()}/heartbeat`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("POST /:id/end returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/agents/${crypto.randomUUID()}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/agents returns all active sessions in workspace", async () => {
		await registerAgent({ name: "agent-1" });
		await registerAgent({ name: "agent-2" });

		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const body = (await listRes.json()) as { items: Array<{ name: string }> };
		const names = body.items.map((s) => s.name);
		expect(names).toContain("agent-1");
		expect(names).toContain("agent-2");
	});
});
