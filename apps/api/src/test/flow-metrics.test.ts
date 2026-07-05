import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture } from "./helpers";

type JsonRpcResult<T> = { jsonrpc: "2.0"; id: unknown; result: T };

interface Distribution {
	count: number;
	avg: number | null;
	p50: number | null;
	p90: number | null;
}

interface FlowMetrics {
	leadTime: Distribution;
	cycleTime: Distribution;
	wipOverTime: Array<{ date: string; count: number }>;
	agentVsHuman: { agent: Distribution; human: Distribution };
}

describe("Flow metrics (PROJ-252)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function stampFlowTimestamps(
		id: string,
		{ readyAt, claimedAt, doneAt }: { readyAt?: number; claimedAt?: number; doneAt?: number }
	) {
		await env.DB.prepare(
			"UPDATE issues SET ready_at = ?, claimed_at = ?, done_at = ? WHERE id = ?"
		)
			.bind(readyAt ?? null, claimedAt ?? null, doneAt ?? null, id)
			.run();
	}

	async function registerAgent(): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "flow-metrics-test-agent" }),
		});
		const session = (await res.json()) as { id: string };
		return session.id;
	}

	async function claim(issueId: string, agentId: string) {
		await SELF.fetch(`http://localhost/api/issues/${issueId}/claim`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ agentId }),
		});
	}

	it("computes lead/cycle time and agent-vs-human split", async () => {
		const now = Math.floor(Date.now() / 1000);

		const agentIssue = await seedIssue(workspaceId, projectId, userId, { title: "Agent-worked" });
		await stampFlowTimestamps(agentIssue.id, {
			readyAt: now - 500,
			claimedAt: now - 400,
			doneAt: now,
		});
		const agentSessionId = await registerAgent();
		await claim(agentIssue.id, agentSessionId);

		const humanIssue = await seedIssue(workspaceId, projectId, userId, { title: "Human-worked" });
		await stampFlowTimestamps(humanIssue.id, {
			readyAt: now - 250,
			claimedAt: now - 200,
			doneAt: now,
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(metrics.leadTime.count).toBe(2);
		expect(metrics.leadTime.avg).toBeCloseTo((500 + 250) / 2, 0);
		expect(metrics.cycleTime.count).toBe(2);
		expect(metrics.cycleTime.avg).toBeCloseTo((400 + 200) / 2, 0);

		expect(metrics.agentVsHuman.agent.count).toBe(1);
		expect(metrics.agentVsHuman.agent.avg).toBeCloseTo(400, 0);
		expect(metrics.agentVsHuman.human.count).toBe(1);
		expect(metrics.agentVsHuman.human.avg).toBeCloseTo(200, 0);

		expect(Array.isArray(metrics.wipOverTime)).toBe(true);
	});

	it("MCP get_flow_metrics matches REST", async () => {
		const restRes = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		const restBody = await restRes.json();

		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_flow_metrics", arguments: { projectId } },
			}),
		});
		const mcpJson = (await mcpRes.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);

		expect(mcpBody).toEqual(restBody);
	});

	it("404s for a project in another workspace", async () => {
		const res = await SELF.fetch("http://localhost/api/projects/does-not-exist/flow-metrics", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});
});
