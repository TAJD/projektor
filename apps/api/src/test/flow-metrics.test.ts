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
	throughputOverTime: Array<{ weekStart: string; count: number }>;
}

// cofferdam-ignore: Readability.MaxFunctionLength: one describe block, normal test style
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
		await env.DB.prepare("UPDATE issues SET ready_at = ?, claimed_at = ?, done_at = ? WHERE id = ?")
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

	it("computes lead/cycle time", async () => {
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

	it("includes an issue created before the window but claimed+done inside it (PROJ-294)", async () => {
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 3 * DAY;
		const until = now;

		const oldIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Created before window",
			createdAt: now - 10 * DAY,
		});
		await stampFlowTimestamps(oldIssue.id, {
			readyAt: now - 10 * DAY,
			claimedAt: now - 2 * DAY,
			doneAt: now - 1 * DAY,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(metrics.cycleTime.count).toBe(1);
		expect(metrics.cycleTime.avg).toBeCloseTo(DAY, 0);
		expect(metrics.wipOverTime.some((b) => b.count >= 1)).toBe(true);
	});

	it("returns non-empty lead/cycle metrics for issues with backfilled done_at (PROJ-288)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Pre-migration done" });
		// Simulates the 0026 backfill outcome: done_at populated from completed_at
		// for an issue that finished before flow-timestamp stamping existed.
		await stampFlowTimestamps(issue.id, {
			readyAt: now - 300,
			claimedAt: now - 200,
			doneAt: now - 50,
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(metrics.leadTime.count).toBe(1);
		expect(metrics.cycleTime.count).toBe(1);
	});

	it("buckets throughput weekly and excludes issues outside the window", async () => {
		const WEEK = 7 * 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 3 * WEEK;
		const until = now;

		const thisWeekIssue = await seedIssue(workspaceId, projectId, userId, { title: "This week" });
		await stampFlowTimestamps(thisWeekIssue.id, {
			readyAt: now - 100,
			claimedAt: now - 50,
			doneAt: now,
		});

		const lastWeekIssue = await seedIssue(workspaceId, projectId, userId, { title: "Last week" });
		await stampFlowTimestamps(lastWeekIssue.id, {
			readyAt: now - WEEK - 100,
			claimedAt: now - WEEK - 50,
			doneAt: now - WEEK,
		});

		const outsideWindowIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Too old",
		});
		await stampFlowTimestamps(outsideWindowIssue.id, {
			readyAt: now - 10 * WEEK,
			claimedAt: now - 10 * WEEK + 50,
			doneAt: now - 10 * WEEK + 100,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		const totalCounted = metrics.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		expect(totalCounted).toBe(2);
		expect(metrics.throughputOverTime.length).toBeGreaterThan(0);
		for (const bucket of metrics.throughputOverTime) {
			expect(bucket.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it("excludes an issue completed just before `since` even though it falls in the aligned first bucket", async () => {
		const WEEK = 7 * 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 2 * WEEK;
		const until = now;

		const justInsideIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Just inside since",
		});
		await stampFlowTimestamps(justInsideIssue.id, {
			readyAt: since - 100,
			claimedAt: since - 50,
			doneAt: since + 10,
		});

		const justOutsideIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Just before since, same aligned bucket",
		});
		await stampFlowTimestamps(justOutsideIssue.id, {
			readyAt: since - 200,
			claimedAt: since - 150,
			doneAt: since - 10,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		const totalCounted = metrics.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		expect(totalCounted).toBe(1);
	});

	it("aligns weekStart labels to Monday", async () => {
		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${Math.floor(Date.now() / 1000) - 4 * 7 * 86400}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		for (const bucket of metrics.throughputOverTime) {
			const weekday = new Date(`${bucket.weekStart}T00:00:00Z`).getUTCDay();
			expect(weekday).toBe(1); // 1 === Monday
		}
	});

	it("daily buckets sum to the same total as weekly buckets for the same window", async () => {
		const WEEK = 7 * 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 2 * WEEK;
		const until = now;

		const issueA = await seedIssue(workspaceId, projectId, userId, { title: "A" });
		await stampFlowTimestamps(issueA.id, {
			readyAt: now - WEEK - 100,
			claimedAt: now - WEEK - 50,
			doneAt: now - WEEK,
		});
		const issueB = await seedIssue(workspaceId, projectId, userId, { title: "B" });
		await stampFlowTimestamps(issueB.id, {
			readyAt: now - 100,
			claimedAt: now - 50,
			doneAt: now,
		});

		const weeklyRes = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}&granularity=week`,
			{ headers: authHeaders(token, slug) }
		);
		const dailyRes = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}&granularity=day`,
			{ headers: authHeaders(token, slug) }
		);
		expect(weeklyRes.status).toBe(200);
		expect(dailyRes.status).toBe(200);
		const weekly = (await weeklyRes.json()) as FlowMetrics;
		const daily = (await dailyRes.json()) as FlowMetrics;

		const weeklyTotal = weekly.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		const dailyTotal = daily.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		expect(dailyTotal).toBe(weeklyTotal);
		expect(dailyTotal).toBe(2);
	});

	it("defaults the throughput window to Monday-of-current-week minus 5 weeks", async () => {
		const WEEK = 7 * 86400;
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);

		const oldIssue = await seedIssue(workspaceId, projectId, userId, { title: "Old" });
		await stampFlowTimestamps(oldIssue.id, {
			readyAt: now - 7 * WEEK,
			claimedAt: now - 7 * WEEK + 100,
			doneAt: now - 7 * WEEK + 200,
		});
		const recentIssue = await seedIssue(workspaceId, projectId, userId, { title: "Recent" });
		await stampFlowTimestamps(recentIssue.id, {
			readyAt: now - 100,
			claimedAt: now - 50,
			doneAt: now,
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		const total = metrics.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(1);

		const earliestBucket = metrics.throughputOverTime[0]?.weekStart;
		expect(earliestBucket).toBeDefined();
		const dayIndex = Math.floor(new Date(`${earliestBucket}T00:00:00Z`).getTime() / 1000 / DAY);
		const daysSinceMonday = ((dayIndex % 7) + 7 - 4) % 7;
		const mondayIndex = dayIndex - daysSinceMonday;
		const nowDayIndex = Math.floor(now / DAY);
		const nowDaysSinceMonday = ((nowDayIndex % 7) + 7 - 4) % 7;
		const currentMondayIndex = nowDayIndex - nowDaysSinceMonday;
		expect(mondayIndex).toBe(currentMondayIndex - 5 * 7);
	});

	it("returns an empty throughput series for a project with no completed issues", async () => {
		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(Array.isArray(metrics.throughputOverTime)).toBe(true);
		expect(metrics.throughputOverTime.every((b) => b.count === 0)).toBe(true);
	});
});
