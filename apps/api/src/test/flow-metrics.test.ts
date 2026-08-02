import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedComment, seedIssue, seedProjectFixture, seedTaskType } from "./helpers";

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
	throughputOverTime: Array<{ bucketStart: string; count: number }>;
	bugShareOverTime: Array<{
		bucketStart: string;
		total: number;
		bugCount: number;
		bugSharePercent: number | null;
	}>;
	bugTypeTracked: boolean;
	reviewLatency: Distribution;
	reviewLatencyOverTime: Array<{ bucketStart: string; p50: number | null }>;
	humanInterventions: Distribution;
	autonomyRatio: Distribution;
	cfdOverTime: Array<{
		bucketStart: string;
		backlogTodo: number;
		inProgress: number;
		inReview: number;
		done: number;
	}>;
	timeInProgress: Distribution;
	arrivalVsCompletionOverTime: Array<{
		bucketStart: string;
		created: number;
		completed: number;
		net: number;
	}>;
	flowEfficiency: Distribution;
	agingWip: Array<{ id: string; status: "in_progress" | "in_review"; ageSeconds: number }>;
	factoryHealth: {
		leaseExpiries: number;
		abandonedClaims: number;
		gateRejections: number;
		wipCapPressure: number;
	};
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

	async function stampReviewFields(
		id: string,
		{ inReviewAt, reviewBounceCount }: { inReviewAt?: number; reviewBounceCount?: number }
	) {
		await env.DB.prepare("UPDATE issues SET in_review_at = ?, review_bounce_count = ? WHERE id = ?")
			.bind(inReviewAt ?? null, reviewBounceCount ?? 0, id)
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

	async function getFlowMetrics(): Promise<FlowMetrics> {
		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as FlowMetrics;
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

		const metrics = await getFlowMetrics();

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

		const metrics = await getFlowMetrics();

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
			expect(bucket.bucketStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

	it("aligns weekly bucketStart labels to Monday", async () => {
		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${Math.floor(Date.now() / 1000) - 4 * 7 * 86400}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		for (const bucket of metrics.throughputOverTime) {
			const weekday = new Date(`${bucket.bucketStart}T00:00:00Z`).getUTCDay();
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

		const metrics = await getFlowMetrics();

		const total = metrics.throughputOverTime.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(1);

		const earliestBucket = metrics.throughputOverTime[0]?.bucketStart;
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
		const metrics = await getFlowMetrics();

		expect(Array.isArray(metrics.throughputOverTime)).toBe(true);
		expect(metrics.throughputOverTime.every((b) => b.count === 0)).toBe(true);
	});

	it("returns null (not NaN/throw) percentiles for a project with zero issues (PROJ-301)", async () => {
		const metrics = await getFlowMetrics();

		for (const dist of [metrics.leadTime, metrics.cycleTime, metrics.reviewLatency]) {
			expect(dist.count).toBe(0);
			expect(dist.avg).toBeNull();
			expect(dist.p50).toBeNull();
			expect(dist.p90).toBeNull();
		}
	});

	it("excludes a NULL-timestamp legacy issue from lead/cycle time without crashing (PROJ-301)", async () => {
		const now = Math.floor(Date.now() / 1000);

		// Pre-dates the PROJ-328 backfill: ready_at/claimed_at/done_at all NULL, even
		// though the issue is otherwise done.
		const legacyIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Legacy done issue",
			status: "done",
		});

		const modernIssue = await seedIssue(workspaceId, projectId, userId, { title: "Modern issue" });
		await stampFlowTimestamps(modernIssue.id, {
			readyAt: now - 300,
			claimedAt: now - 200,
			doneAt: now,
		});

		const metrics = await getFlowMetrics();

		// The legacy issue contributes nothing — only the modern issue is counted.
		expect(metrics.leadTime.count).toBe(1);
		expect(metrics.cycleTime.count).toBe(1);
		expect(metrics.agingWip.every((a) => a.id !== legacyIssue.id)).toBe(true);
	});

	// PROJ-328: collaboration-shape metrics (review latency, human interventions, autonomy ratio).
	async function stampLease(
		id: string,
		issueId: string,
		claimedAt: number,
		releasedAt: number | null
	) {
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO agent_sessions
			   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, ?, NULL, 'lease-test-agent', 'agent', 'ended', ?, ?, ?)`
		)
			.bind(id, workspaceId, issueId, now, now, now)
			.run();
		await env.DB.prepare(
			`INSERT INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				issueId,
				id,
				claimedAt,
				releasedAt,
				releasedAt ? "released" : null
			)
			.run();
	}

	it("computes review latency (in_review -> done)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Reviewed" });
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 400, doneAt: now });
		await stampReviewFields(issue.id, { inReviewAt: now - 100 });

		const metrics = await getFlowMetrics();

		expect(metrics.reviewLatency.count).toBe(1);
		expect(metrics.reviewLatency.avg).toBeCloseTo(100, 0);
		expect(Array.isArray(metrics.reviewLatencyOverTime)).toBe(true);
	});

	it("counts human comments + review bounces as human interventions, excluding agent comments", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Intervened" });
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 400, doneAt: now });
		await stampReviewFields(issue.id, { inReviewAt: now - 100, reviewBounceCount: 2 });
		await seedComment(issue.id, userId, "Looks good", "human");
		await seedComment(issue.id, userId, "wip update", "agent");
		await seedComment(issue.id, userId, "legacy comment, no authorKind");

		const metrics = await getFlowMetrics();

		expect(metrics.humanInterventions.count).toBe(1);
		// 1 human comment + 2 review bounces; the agent comment and the authorKind-less
		// legacy comment are both excluded.
		expect(metrics.humanInterventions.avg).toBe(3);
	});

	it("computes autonomy ratio as lease-held time over cycle time", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Leased" });
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 400, doneAt: now });
		await stampLease(crypto.randomUUID(), issue.id, now - 400, now - 200);

		const metrics = await getFlowMetrics();

		expect(metrics.autonomyRatio.count).toBe(1);
		expect(metrics.autonomyRatio.avg).toBeCloseTo(0.5, 1);
	});

	it("clamps autonomy ratio to 1 when leases held time exceeds cycle time", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Over-leased" });
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 400, doneAt: now });
		// Lease still held past doneAt (released_at NULL) — counts through doneAt, not "now".
		await stampLease(crypto.randomUUID(), issue.id, now - 400, null);

		const metrics = await getFlowMetrics();

		expect(metrics.autonomyRatio.avg).toBeLessThanOrEqual(1);
		expect(metrics.autonomyRatio.avg).toBeCloseTo(1, 1);
	});

	// PROJ-329: cumulative flow diagram + time-in-state breakdown.
	it("buckets CFD bands correctly for seeded transitions, never negative, done monotonic", async () => {
		const DAY = 86400;
		const WEEK = 7 * DAY;
		const now = Math.floor(Date.now() / 1000);
		// Day-align since/until so the bucket loop (which starts at a day boundary and
		// steps by exactly one day) lands its first/last samples exactly on since/until,
		// regardless of what time of day the suite runs.
		const todayStart = now - (now % DAY);
		const since = todayStart - 2 * WEEK;
		const until = todayStart;

		// Sits in backlog/todo for the whole window.
		await seedIssue(workspaceId, projectId, userId, {
			title: "Backlog",
			createdAt: since - DAY - 100,
		});

		// Claimed mid-window, never reaches review or done — in_progress by the end.
		const inProgressIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "In progress",
			createdAt: since - DAY - 100,
		});
		await stampFlowTimestamps(inProgressIssue.id, { claimedAt: since + WEEK });

		// Reaches review a week before `until` and finishes right at `until`.
		const doneIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Done",
			createdAt: since - DAY - 100,
		});
		await stampFlowTimestamps(doneIssue.id, {
			claimedAt: since + 10,
			doneAt: until,
		});
		await stampReviewFields(doneIssue.id, { inReviewAt: until - WEEK });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}&granularity=day`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(metrics.cfdOverTime.length).toBeGreaterThan(0);

		for (const bucket of metrics.cfdOverTime) {
			expect(bucket.backlogTodo).toBeGreaterThanOrEqual(0);
			expect(bucket.inProgress).toBeGreaterThanOrEqual(0);
			expect(bucket.inReview).toBeGreaterThanOrEqual(0);
			expect(bucket.done).toBeGreaterThanOrEqual(0);
		}

		// done is cumulative — never decreases bucket over bucket.
		for (let i = 1; i < metrics.cfdOverTime.length; i++) {
			expect(metrics.cfdOverTime[i].done).toBeGreaterThanOrEqual(metrics.cfdOverTime[i - 1].done);
		}

		// PROJ-377: buckets are now sampled at their *end* (clamped to until/now), not
		// their start — the "Done" issue's claimedAt (since + 10s) already falls before
		// the first bucket's end, so it reads as in_progress rather than backlog/todo.
		const firstBucket = metrics.cfdOverTime[0];
		expect(firstBucket.backlogTodo).toBe(2);
		expect(firstBucket.inProgress).toBe(1);
		expect(firstBucket.inReview).toBe(0);
		expect(firstBucket.done).toBe(0);

		const lastBucket = metrics.cfdOverTime[metrics.cfdOverTime.length - 1];
		expect(lastBucket.backlogTodo).toBe(1);
		expect(lastBucket.inProgress).toBe(1);
		expect(lastBucket.done).toBe(1);
	});

	// PROJ-377: the current (still-partial) bucket must reflect state as of "now", not
	// as of the bucket's start — previously an issue created and completed entirely
	// within the current week's bucket read as all-zero because the sample instant (the
	// bucket's start) predated the activity.
	it("reflects a same-bucket create+complete burst in the current (partial) bucket", async () => {
		const now = Math.floor(Date.now() / 1000);

		const burstIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Created and finished this week",
			createdAt: now - 100,
		});
		await stampFlowTimestamps(burstIssue.id, {
			readyAt: now - 90,
			claimedAt: now - 60,
			doneAt: now - 10,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?granularity=week`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		const currentBucket = metrics.cfdOverTime[metrics.cfdOverTime.length - 1];
		expect(currentBucket.done).toBe(1);
	});

	it("computes time in progress (claimed -> next stage) for issues completing in the window", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Progressed" });
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 400, doneAt: now });
		await stampReviewFields(issue.id, { inReviewAt: now - 100 });

		const metrics = await getFlowMetrics();

		expect(metrics.timeInProgress.count).toBe(1);
		expect(metrics.timeInProgress.avg).toBeCloseTo(300, 0); // claimed -400 -> in_review -100
	});

	// PROJ-330: arrival vs completion, flow efficiency, aging-WIP scatter.
	it("buckets arrival vs completion, reporting net = created - completed", async () => {
		const WEEK = 7 * 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 2 * WEEK;
		const until = now;

		// Created this window, not yet done: counts as an arrival, not a completion.
		await seedIssue(workspaceId, projectId, userId, { title: "New arrival", createdAt: now - 100 });

		// Created before the window, completed inside it: counts as a completion only.
		const completedIssue = await seedIssue(workspaceId, projectId, userId, {
			title: "Completed",
			createdAt: now - 10 * WEEK,
		});
		await stampFlowTimestamps(completedIssue.id, {
			readyAt: now - 300,
			claimedAt: now - 200,
			doneAt: now - 50,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		const totalCreated = metrics.arrivalVsCompletionOverTime.reduce((sum, b) => sum + b.created, 0);
		const totalCompleted = metrics.arrivalVsCompletionOverTime.reduce(
			(sum, b) => sum + b.completed,
			0
		);
		expect(totalCreated).toBe(1);
		expect(totalCompleted).toBe(1);
		for (const bucket of metrics.arrivalVsCompletionOverTime) {
			expect(bucket.net).toBe(bucket.created - bucket.completed);
		}
	});

	it("computes flow efficiency as lease-held time over lead time, distinct from autonomy ratio", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Queued then leased" });
		// ready -500, claimed -300 (200s queued before claim), done now: lead time 500, cycle time 300.
		await stampFlowTimestamps(issue.id, { readyAt: now - 500, claimedAt: now - 300, doneAt: now });
		await stampLease(crypto.randomUUID(), issue.id, now - 300, now - 150); // 150s held

		const metrics = await getFlowMetrics();

		expect(metrics.flowEfficiency.count).toBe(1);
		expect(metrics.flowEfficiency.avg).toBeCloseTo(150 / 500, 1); // held / lead time
		expect(metrics.autonomyRatio.avg).toBeCloseTo(150 / 300, 1); // held / cycle time
		expect(metrics.flowEfficiency.avg).toBeLessThan(metrics.autonomyRatio.avg ?? 0);
	});

	it("includes an old still-open issue in the aging-WIP scatter", async () => {
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);

		const oldInProgress = await seedIssue(workspaceId, projectId, userId, {
			title: "Stuck in progress",
			status: "in_progress",
			createdAt: now - 30 * DAY,
		});
		await stampFlowTimestamps(oldInProgress.id, { claimedAt: now - 20 * DAY });

		const inReview = await seedIssue(workspaceId, projectId, userId, {
			title: "In review",
			status: "in_review",
			createdAt: now - 5 * DAY,
		});
		await stampFlowTimestamps(inReview.id, { claimedAt: now - 2 * DAY });

		// Backlog issue must not appear in the scatter (not currently in progress/review).
		await seedIssue(workspaceId, projectId, userId, { title: "Still backlog" });

		const metrics = await getFlowMetrics();

		expect(metrics.agingWip.length).toBe(2);
		const stuck = metrics.agingWip.find((a) => a.id === oldInProgress.id);
		expect(stuck).toBeDefined();
		expect(stuck?.status).toBe("in_progress");
		expect(stuck?.ageSeconds).toBeCloseTo(20 * DAY, -2);
		const reviewing = metrics.agingWip.find((a) => a.id === inReview.id);
		expect(reviewing?.status).toBe("in_review");
	});

	// PROJ-331: throughput by task type — bug-share % trend, untyped grouped in (not dropped).
	it("computes bug share per bucket, counting untyped issues toward total but not bugCount", async () => {
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);
		const bugType = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
		const taskType = await seedTaskType(workspaceId, { key: "task", name: "Task" });

		// Bucket A (older): 1 bug + 1 task completed -> 50% bug share.
		const bug1 = await seedIssue(workspaceId, projectId, userId, {
			title: "Bug 1",
			typeId: bugType.id,
		});
		await stampFlowTimestamps(bug1.id, { doneAt: now - 10 * DAY });
		const task1 = await seedIssue(workspaceId, projectId, userId, {
			title: "Task 1",
			typeId: taskType.id,
		});
		await stampFlowTimestamps(task1.id, { doneAt: now - 10 * DAY });

		// Bucket B (recent): 1 bug + 1 untyped completed -> 50% bug share, untyped counts
		// toward total but not bugCount.
		const bug2 = await seedIssue(workspaceId, projectId, userId, {
			title: "Bug 2",
			typeId: bugType.id,
		});
		await stampFlowTimestamps(bug2.id, { doneAt: now });
		const untyped = await seedIssue(workspaceId, projectId, userId, { title: "Untyped" });
		await stampFlowTimestamps(untyped.id, { doneAt: now });

		const since = now - 11 * DAY;
		const until = now;
		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}&granularity=week`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(Array.isArray(metrics.bugShareOverTime)).toBe(true);
		const nonEmptyBuckets = metrics.bugShareOverTime.filter((b) => b.total > 0);
		expect(nonEmptyBuckets.length).toBe(2);
		for (const bucket of nonEmptyBuckets) {
			expect(bucket.total).toBe(2);
			expect(bucket.bugCount).toBe(1);
			expect(bucket.bugSharePercent).toBeCloseTo(0.5, 5);
		}

		const emptyBucket = metrics.bugShareOverTime.find((b) => b.total === 0);
		if (emptyBucket) expect(emptyBucket.bugSharePercent).toBeNull();
		expect(metrics.bugTypeTracked).toBe(true);
	});

	// PROJ-341: a workspace with no "bug"-keyed task type (renamed/deleted default) must
	// produce a clearly-distinguishable state, not indistinguishable "0 bugs, tracked".
	it("flags bugTypeTracked false when no 'bug'-keyed task type exists in the workspace", async () => {
		const now = Math.floor(Date.now() / 1000);
		await seedTaskType(workspaceId, { key: "defect", name: "Defect" });
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Untracked" });
		await stampFlowTimestamps(issue.id, { doneAt: now });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${now - 86400}&until=${now}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;
		expect(metrics.bugTypeTracked).toBe(false);
	});
});

// PROJ-334: factory health tiles — fault signals for the machinery itself, windowed by
// when the fault EVENT happened (released_at/occurred_at), not by issue doneAt like the
// distribution tiles above.
describe("Factory health tiles (PROJ-334)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	// Bypasses the claim/release APIs so tests can place events at an arbitrary
	// timestamp, inside or outside the window under test.
	async function seedLease(
		issueId: string,
		releaseReason: string | null,
		releasedAt: number | null
	) {
		const agentSessionId = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO agent_sessions
			   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, ?, NULL, 'seed-agent', 'agent', 'ended', ?, ?, ?)`
		)
			.bind(agentSessionId, workspaceId, issueId, now, now, now)
			.run();
		await env.DB.prepare(
			`INSERT INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				issueId,
				agentSessionId,
				now,
				releasedAt,
				releaseReason
			)
			.run();
	}

	async function seedFileClaim(
		issueId: string,
		releaseReason: string | null,
		releasedAt: number | null
	) {
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			"INSERT INTO issue_file_claims (id, workspace_id, issue_id, agent_id, path, claimed_at, " +
				"released_at, release_reason) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)"
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				issueId,
				`src/${crypto.randomUUID()}.ts`,
				now,
				releasedAt,
				releaseReason
			)
			.run();
	}

	async function seedGateRejection(issueId: string, occurredAt: number) {
		await env.DB.prepare(
			"INSERT INTO issue_gate_rejections (id, workspace_id, issue_id, occurred_at) VALUES (?, ?, ?, ?)"
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, occurredAt)
			.run();
	}

	async function seedWipCapDenial(project: string, issueId: string, occurredAt: number) {
		await env.DB.prepare(
			"INSERT INTO wip_cap_denials (id, workspace_id, project_id, issue_id, agent_session_id, " +
				"occurred_at) VALUES (?, ?, ?, ?, NULL, ?)"
		)
			.bind(crypto.randomUUID(), workspaceId, project, issueId, occurredAt)
			.run();
	}

	it("counts lease expiries, abandoned claims, and gate rejections within the window", async () => {
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 3 * DAY;
		const until = now;

		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Faulty" });

		// In window: counts.
		await seedLease(issue.id, "expired", now - 1 * DAY);
		await seedFileClaim(issue.id, "agent_ended", now - 1 * DAY);
		await seedGateRejection(issue.id, now - 1 * DAY);
		await seedWipCapDenial(projectId, issue.id, now - 1 * DAY);

		// Out of window: excluded.
		await seedLease(issue.id, "expired", now - 10 * DAY);
		await seedFileClaim(issue.id, "agent_ended", now - 10 * DAY);
		await seedGateRejection(issue.id, now - 10 * DAY);
		await seedWipCapDenial(projectId, issue.id, now - 10 * DAY);

		// Right reason but not a fault (deliberate release / reclaim by another agent) —
		// excluded regardless of window.
		await seedLease(issue.id, "released", now - 1 * DAY);
		await seedLease(issue.id, "agent_ended", now - 1 * DAY);
		await seedFileClaim(issue.id, "released", now - 1 * DAY);
		await seedFileClaim(issue.id, "overridden", now - 1 * DAY);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as FlowMetrics;

		expect(metrics.factoryHealth).toEqual({
			leaseExpiries: 1,
			abandonedClaims: 1,
			gateRejections: 1,
			wipCapPressure: 1,
		});
	});

	it("scopes factory health counts to the requested project", async () => {
		const now = Math.floor(Date.now() / 1000);
		const other = await seedProjectFixture({ role: "owner" });

		const issue = await seedIssue(workspaceId, projectId, userId, { title: "This project" });
		await seedLease(issue.id, "expired", now);
		await seedWipCapDenial(projectId, issue.id, now);

		const otherIssue = await seedIssue(other.workspaceId, other.projectId, other.userId, {
			title: "Other project",
		});
		await env.DB.prepare(
			`INSERT INTO agent_sessions
			   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, ?, NULL, 'seed-agent', 'agent', 'ended', ?, ?, ?)`
		)
			.bind(crypto.randomUUID(), other.workspaceId, otherIssue.id, now, now, now)
			.run();
		await seedWipCapDenial(other.projectId, otherIssue.id, now);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${now - 100}&until=${now + 100}`,
			{ headers: authHeaders(token, slug) }
		);
		const metrics = (await res.json()) as FlowMetrics;
		expect(metrics.factoryHealth.leaseExpiries).toBe(1);
		expect(metrics.factoryHealth.wipCapPressure).toBe(1);
	});

	it("empty state: all counts are zero when nothing has faulted", async () => {
		const now = Math.floor(Date.now() / 1000);
		await seedIssue(workspaceId, projectId, userId, { title: "Healthy" });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${now - 86400}&until=${now}`,
			{ headers: authHeaders(token, slug) }
		);
		const metrics = (await res.json()) as FlowMetrics;
		expect(metrics.factoryHealth).toEqual({
			leaseExpiries: 0,
			abandonedClaims: 0,
			gateRejections: 0,
			wipCapPressure: 0,
		});
	});
});
