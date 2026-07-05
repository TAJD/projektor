import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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

		const withoutFlag = await callPrioritized({ limit: 50 });
		expect(withoutFlag.issues.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

		const withFlag = await callPrioritized({ limit: 50, excludeClaimed: true });
		const ids = withFlag.issues.map((i) => i.id);
		expect(ids).toContain(b.id);
		expect(ids).not.toContain(a.id);
	});
});
