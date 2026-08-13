import { env, SELF } from "cloudflare:test";
import { drizzle, schema } from "@projektor/db";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAgentWipCap } from "../services/issue-leases";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedFixture, seedIssue, seedProjectFixture } from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Issue leases API (PROJ-184)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
	});

	async function registerAgent(name: string): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name }),
		});
		const session = (await res.json()) as { id: string };
		return session.id;
	}

	function claim(issueId: string, agentId: string) {
		return SELF.fetch(`http://localhost/api/issues/${issueId}/claim`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentId }),
		});
	}

	function release(issueId: string, agentId?: string) {
		return SELF.fetch(`http://localhost/api/issues/${issueId}/release`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify(agentId ? { agentId } : {}),
		});
	}

	function backdateHeartbeat(agentId: string, secondsAgo = 200) {
		const stale = Math.floor(Date.now() / 1000) - secondsAgo;
		return env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(stale, agentId)
			.run();
	}

	it("claims an unleased issue", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Claim me" });
		const agent = await registerAgent("a1");

		const res = await claim(issue.id, agent);
		expect(res.status).toBe(201);
		const lease = (await res.json()) as { issueId: string; agentSessionId: string };
		expect(lease.issueId).toBe(issue.id);
		expect(lease.agentSessionId).toBe(agent);
	});

	it("rejects a second claim while the first holder is live", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Contended" });
		const a1 = await registerAgent("a1");
		const a2 = await registerAgent("a2");

		expect((await claim(issue.id, a1)).status).toBe(201);
		const res = await claim(issue.id, a2);
		expect(res.status).toBe(409); // ConflictError
	});

	it("reclaims a lease whose holder stopped heartbeating", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Stale holder" });
		const a1 = await registerAgent("a1");
		const a2 = await registerAgent("a2");

		expect((await claim(issue.id, a1)).status).toBe(201);
		// a1 goes dark — its session is now stale, so its lease is reclaimable.
		await backdateHeartbeat(a1);

		const res = await claim(issue.id, a2);
		expect(res.status).toBe(201);
		const lease = (await res.json()) as { agentSessionId: string };
		expect(lease.agentSessionId).toBe(a2);
	});

	it("refuses a claim from an agent that is not live", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Dead claimer" });
		const a1 = await registerAgent("a1");
		await backdateHeartbeat(a1);

		const res = await claim(issue.id, a1);
		expect(res.status).toBe(400); // ValidationError — heartbeat first
	});

	it("release frees the issue for another agent", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Release me" });
		const a1 = await registerAgent("a1");
		const a2 = await registerAgent("a2");

		expect((await claim(issue.id, a1)).status).toBe(201);
		expect((await release(issue.id)).status).toBe(200);
		// Now claimable again.
		expect((await claim(issue.id, a2)).status).toBe(201);
	});

	it("ending an agent releases its leases", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "End releases" });
		const a1 = await registerAgent("a1");
		const a2 = await registerAgent("a2");

		expect((await claim(issue.id, a1)).status).toBe(201);
		const endRes = await SELF.fetch(`http://localhost/api/agents/${a1}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(endRes.status).toBe(200);

		// a1's lease was released on end → a2 can claim.
		expect((await claim(issue.id, a2)).status).toBe(201);
	});

	it("GET /:id/leases lists the active lease with a live flag", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Listed" });
		const a1 = await registerAgent("a1");
		await claim(issue.id, a1);

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}/leases`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ agentSessionId: string; live: boolean }> };
		expect(body.items).toHaveLength(1);
		expect(body.items[0].agentSessionId).toBe(a1);
		expect(body.items[0].live).toBe(true);
	});

	it("workspace isolation: cannot claim an issue from another workspace", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Mine" });
		const other = await seedFixture();
		const otherAgentRes = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ name: "intruder" }),
		});
		const otherAgent = (await otherAgentRes.json()) as { id: string };

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}/claim`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ agentId: otherAgent.id }),
		});
		expect(res.status).toBe(404); // issue not found in the intruder's workspace
	});
});

describe("get_prioritized_issues excludeClaimed (PROJ-184)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
	});

	async function callPrioritized(args: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_prioritized_issues", arguments: args },
			}),
		});
		const json = (await res.json()) as {
			result?: { content: Array<{ text: string }> };
		};
		const text = json.result?.content?.[0]?.text ?? "{}";
		return JSON.parse(text) as { issues: Array<{ id: string }> };
	}

	it("excludes live-leased issues only when excludeClaimed is true", async () => {
		const a = await seedIssue(workspaceId, projectId, userId, { title: "A", priority: "high" });
		const b = await seedIssue(workspaceId, projectId, userId, { title: "B", priority: "high" });

		const agentRes = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "worker" }),
		});
		const agent = (await agentRes.json()) as { id: string };
		await SELF.fetch(`http://localhost/api/issues/${a.id}/claim`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentId: agent.id }),
		});

		const withoutFlag = await callPrioritized({ limit: 50, includeNotReady: true });
		expect(withoutFlag.issues.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

		const withFlag = await callPrioritized({
			limit: 50,
			excludeClaimed: true,
			includeNotReady: true,
		});
		const ids = withFlag.issues.map((i) => i.id);
		expect(ids).toContain(b.id);
		expect(ids).not.toContain(a.id);
	});
});

describe("claim_issue agent WIP limit (PROJ-253)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function registerAgent(name: string): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name }),
		});
		const session = (await res.json()) as { id: string };
		return session.id;
	}

	function claim(issueId: string, agentId: string) {
		return SELF.fetch(`http://localhost/api/issues/${issueId}/claim`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentId }),
		});
	}

	// Under a WIP cap of 1: registers an agent, seeds two issues, and asserts the first
	// claim succeeds while the second is rejected as over-cap.
	async function expectWipCapBlocksSecondClaim() {
		const agent = await registerAgent("worker");
		const [first, second] = await Promise.all([
			seedIssue(workspaceId, projectId, userId, { title: "First" }),
			seedIssue(workspaceId, projectId, userId, { title: "Second" }),
		]);

		expect((await claim(first.id, agent)).status).toBe(201);
		const res = await claim(second.id, agent);
		expect(res.status).toBe(409);
	}

	it("blocks the 4th concurrent agent-held lease at the default cap of 3", async () => {
		const agent = await registerAgent("worker");
		const issues = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				seedIssue(workspaceId, projectId, userId, { title: `Issue ${i}` })
			)
		);

		for (const issue of issues.slice(0, 3)) {
			expect((await claim(issue.id, agent)).status).toBe(201);
		}

		const res = await claim(issues[3].id, agent);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(JSON.stringify(body)).toMatch(/WIP limit/i);
	});

	// PROJ-624: the Nth claim (at the cap) must succeed and the (N+1)th must be
	// rejected with an error that names the actual configured cap — read from
	// fetchAgentWipCap (exported), not retyped as a literal, so the assertion
	// stays honest if DEFAULT_AGENT_WIP_LIMIT ever changes.
	it("PROJ-624: claim at the cap succeeds; the (cap+1)th is rejected and the error names the cap", async () => {
		const orm = drizzle(env.DB, { schema });
		const cap = await fetchAgentWipCap(orm, { workspaceId } as ServiceCtx, projectId);

		const agent = await registerAgent("worker");
		const issues = await Promise.all(
			Array.from({ length: cap + 1 }, (_, i) =>
				seedIssue(workspaceId, projectId, userId, { title: `Cap ${i}` })
			)
		);

		for (const issue of issues.slice(0, cap)) {
			expect((await claim(issue.id, agent)).status).toBe(201);
		}

		const res = await claim(issues[cap].id, agent);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		// Anchored to the phrase, not a bare `toContain(String(cap))`: the message
		// also lists `cap` held issue UUIDs, and a single digit occurs in those by
		// chance often enough that the loose form passes even if the cap is dropped.
		expect(body.error).toMatch(new RegExp(`WIP limit reached \\(${cap}\\)`));
	});

	it("records a wip_cap_denials event when a claim is rejected over-cap (PROJ-342)", async () => {
		const agent = await registerAgent("worker");
		const issues = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				seedIssue(workspaceId, projectId, userId, { title: `Denial ${i}` })
			)
		);

		for (const issue of issues.slice(0, 3)) {
			expect((await claim(issue.id, agent)).status).toBe(201);
		}

		expect((await claim(issues[3].id, agent)).status).toBe(409);

		const row = await env.DB.prepare(
			"SELECT project_id, issue_id, agent_session_id FROM wip_cap_denials WHERE workspace_id = ?"
		)
			.bind(workspaceId)
			.first<{ project_id: string; issue_id: string; agent_session_id: string }>();

		expect(row).not.toBeNull();
		expect(row?.project_id).toBe(projectId);
		expect(row?.issue_id).toBe(issues[3].id);
		expect(row?.agent_session_id).toBe(agent);
	});

	it("TOCTOU: N concurrent claims never push a project over the cap (PROJ-290)", async () => {
		const agent = await registerAgent("worker");
		const issues = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				seedIssue(workspaceId, projectId, userId, { title: `C${i}` })
			)
		);

		// Fire all claims at once: the read-then-insert bug let several each see cap-1
		// and all proceed. The guarded INSERT must let at most `cap` (default 3) win.
		const results = await Promise.all(issues.map((iss) => claim(iss.id, agent)));
		const granted = results.filter((r) => r.status === 201).length;
		expect(granted).toBeLessThanOrEqual(3);

		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM issue_leases il JOIN issues i ON i.id = il.issue_id
			 WHERE il.released_at IS NULL AND i.project_id = ?`
		)
			.bind(projectId)
			.first<{ n: number }>();
		expect(row!.n).toBeLessThanOrEqual(3);
	});

	it("respects a project's own agent_wip_limit override", async () => {
		const patchRes = await SELF.fetch(`http://localhost/api/projects/${projectId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentWipLimit: 1 }),
		});
		expect(patchRes.status).toBe(200);

		await expectWipCapBlocksSecondClaim();
	});

	// --- REST/MCP parity (PROJ-301) ---

	it("MCP parity: update_project sets agent_wip_limit the same as REST PATCH", async () => {
		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update_project", arguments: { id: projectId, agentWipLimit: 1 } },
			}),
		});
		expect(mcpRes.status).toBe(200);

		await expectWipCapBlocksSecondClaim();
	});

	it("MCP parity: create_project sets agent_wip_limit the same as REST create", async () => {
		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create_project",
					arguments: { name: "MCP WIP Project", key: "MCPWIP", agentWipLimit: 1 },
				},
			}),
		});
		expect(mcpRes.status).toBe(200);
		const body = (await mcpRes.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const created = JSON.parse(body.result.content[0].text) as { id: string };

		const agent = await registerAgent("worker2");
		const [first, second] = await Promise.all([
			seedIssue(workspaceId, created.id, userId, { title: "First" }),
			seedIssue(workspaceId, created.id, userId, { title: "Second" }),
		]);

		expect((await claim(first.id, agent)).status).toBe(201);
		const res = await claim(second.id, agent);
		expect(res.status).toBe(409);
	});
});
