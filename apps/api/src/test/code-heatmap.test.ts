import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CodeHeatmapEntry, ContentionHeatmapEntry } from "../services/code-heatmap";
import { authHeaders, seedIssue, seedProjectFixture } from "./helpers";

interface CodeHeatmapResponse {
	prefix: string;
	totalDistinctIssues: number;
	entries: CodeHeatmapEntry[];
}

interface ContentionHeatmapResponse {
	prefix: string;
	totalDistinctIssues: number;
	entries: ContentionHeatmapEntry[];
}

async function expectHeatmapOk(res: Response): Promise<CodeHeatmapResponse> {
	expect(res.status).toBe(200);
	return (await res.json()) as CodeHeatmapResponse;
}

function expectAppsGroup<E extends { path: string; isLeaf: boolean }>(entries: readonly E[]): E {
	const apps = entries.find((e) => e.path === "apps");
	expect(apps).toBeDefined();
	expect(apps?.isLeaf).toBe(false);
	return apps as E;
}

// cofferdam-ignore: Readability.MaxFunctionLength: one describe block, normal test style
describe("Code heatmap (PROJ-332)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	// Bypasses the claim_files API (which always stamps "now") so tests can place claims
	// inside/outside an arbitrary window, and the active-claim unique index (which is
	// scoped to workspace+path, not directory) is never at risk since each seeded path is
	// distinct.
	async function seedClaim(issueId: string, path: string, claimedAt: number, releasedAt?: number) {
		await env.DB.prepare(
			"INSERT INTO issue_file_claims (id, workspace_id, issue_id, agent_id, path, claimed_at, " +
				"released_at) VALUES (?, ?, ?, NULL, ?, ?, ?)"
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, path, claimedAt, releasedAt ?? null)
			.run();
	}

	async function seedConflict(
		rejectedIssueId: string,
		holdingIssueId: string,
		path: string,
		occurredAt: number,
		forced = 0
	) {
		await env.DB.prepare(
			"INSERT INTO claim_conflicts (id, workspace_id, path, rejected_issue_id, rejected_agent_id, " +
				"holding_issue_id, holding_agent_id, forced, occurred_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)"
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				path,
				rejectedIssueId,
				holdingIssueId,
				forced,
				occurredAt
			)
			.run();
	}

	async function getHeatmap(params: Record<string, string> = {}) {
		const qs = new URLSearchParams(params).toString();
		return SELF.fetch(
			`http://localhost/api/projects/${projectId}/code-heatmap${qs ? `?${qs}` : ""}`,
			{
				headers: authHeaders(token, slug),
			}
		);
	}

	it("aggregates distinct issues per top-level directory within the window", async () => {
		const now = Math.floor(Date.now() / 1000);
		const apiIssue = await seedIssue(workspaceId, projectId, userId, { title: "API work" });
		const apiIssue2 = await seedIssue(workspaceId, projectId, userId, { title: "More API work" });
		const webIssue = await seedIssue(workspaceId, projectId, userId, { title: "Web work" });
		const oldIssue = await seedIssue(workspaceId, projectId, userId, { title: "Old work" });

		await seedClaim(apiIssue.id, "apps/api/src/services/flow-metrics.ts", now - 1000);
		await seedClaim(apiIssue.id, "apps/api/src/services/code-heatmap.ts", now - 900);
		await seedClaim(apiIssue2.id, "apps/api/src/routes/code-heatmap.ts", now - 800);
		await seedClaim(webIssue.id, "apps/web/src/islands/MetricsDashboard.tsx", now - 700);
		// Outside the requested window — must not count.
		await seedClaim(oldIssue.id, "apps/api/src/routes/old.ts", now - 10 * 86400);

		const res = await getHeatmap({ since: String(now - 3600), until: String(now) });
		const body = await expectHeatmapOk(res);

		expect(body.prefix).toBe("");
		expect(body.totalDistinctIssues).toBe(3);

		const apps = expectAppsGroup(body.entries);
		expect(apps.distinctIssueCount).toBe(3);
		expect(apps.claimCount).toBe(4);
	});

	it("drills down via prefix, one segment at a time", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issueA = await seedIssue(workspaceId, projectId, userId, { title: "A" });
		const issueB = await seedIssue(workspaceId, projectId, userId, { title: "B" });

		await seedClaim(issueA.id, "apps/api/src/services/flow-metrics.ts", now - 100);
		await seedClaim(issueB.id, "apps/api/src/services/code-heatmap.ts", now - 90);
		await seedClaim(issueA.id, "apps/web/src/islands/MetricsDashboard.tsx", now - 80);

		const apiRes = await getHeatmap({
			since: String(now - 3600),
			until: String(now),
			prefix: "apps/api/src/services",
		});
		const apiBody = await expectHeatmapOk(apiRes);
		expect(apiBody.prefix).toBe("apps/api/src/services");
		const paths = apiBody.entries.map((e) => e.path).sort();
		expect(paths).toEqual([
			"apps/api/src/services/code-heatmap.ts",
			"apps/api/src/services/flow-metrics.ts",
		]);
		expect(apiBody.entries.every((e) => e.isLeaf)).toBe(true);
		expect(apiBody.entries.every((e) => e.distinctIssueCount === 1)).toBe(true);
	});

	it("counts a released claim toward the aggregate (soft-release retains history)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Released work" });
		await seedClaim(issue.id, "apps/api/src/routes/code-heatmap.ts", now - 500, now - 100);

		const res = await getHeatmap({ since: String(now - 3600), until: String(now) });
		const body = (await res.json()) as CodeHeatmapResponse;
		expect(body.totalDistinctIssues).toBe(1);
	});

	it("treats a path claimed as both file and directory as a drillable directory", async () => {
		const now = Math.floor(Date.now() / 1000);
		const fileIssue = await seedIssue(workspaceId, projectId, userId, { title: "File claim" });
		const dirIssue = await seedIssue(workspaceId, projectId, userId, { title: "Dir claim" });
		// File claim seeded first so its isLeaf=true must not freeze the group as a leaf.
		await seedClaim(fileIssue.id, "docs", now - 200);
		await seedClaim(dirIssue.id, "docs/guide.md", now - 100);

		const res = await getHeatmap({ since: String(now - 3600), until: String(now) });
		const body = (await res.json()) as CodeHeatmapResponse;
		const docs = body.entries.find((e) => e.path === "docs");
		expect(docs).toBeDefined();
		expect(docs?.isLeaf).toBe(false);
		expect(docs?.distinctIssueCount).toBe(2);
	});

	it("returns an empty entries array when no claims exist in the window", async () => {
		const now = Math.floor(Date.now() / 1000);
		const res = await getHeatmap({ since: String(now - 3600), until: String(now) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as CodeHeatmapResponse;
		expect(body.entries).toEqual([]);
		expect(body.totalDistinctIssues).toBe(0);
	});

	it("MCP get_code_heatmap matches REST", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Parity check" });
		await seedClaim(issue.id, "apps/api/src/services/code-heatmap.ts", now - 100);

		const query = `since=${now - 3600}&until=${now}`;
		const restRes = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/code-heatmap?${query}`,
			{ headers: authHeaders(token, slug) }
		);
		const restBody = await restRes.json();

		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "get_code_heatmap",
					arguments: { projectId, since: now - 3600, until: now },
				},
			}),
		});
		const mcpJson = (await mcpRes.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);

		expect(mcpBody).toEqual(restBody);
	});

	describe("contention mode (PROJ-338)", () => {
		it("aggregates distinct rejected issues per top-level directory within the window", async () => {
			const now = Math.floor(Date.now() / 1000);
			const holdingIssue = await seedIssue(workspaceId, projectId, userId, { title: "Holder" });
			const apiIssue = await seedIssue(workspaceId, projectId, userId, { title: "API rejected" });
			const apiIssue2 = await seedIssue(workspaceId, projectId, userId, {
				title: "More API rejected",
			});
			const webIssue = await seedIssue(workspaceId, projectId, userId, { title: "Web rejected" });
			const oldIssue = await seedIssue(workspaceId, projectId, userId, { title: "Old rejected" });

			await seedConflict(
				apiIssue.id,
				holdingIssue.id,
				"apps/api/src/services/flow-metrics.ts",
				now - 1000
			);
			await seedConflict(
				apiIssue.id,
				holdingIssue.id,
				"apps/api/src/services/code-heatmap.ts",
				now - 900
			);
			await seedConflict(
				apiIssue2.id,
				holdingIssue.id,
				"apps/api/src/routes/code-heatmap.ts",
				now - 800
			);
			await seedConflict(
				webIssue.id,
				holdingIssue.id,
				"apps/web/src/islands/MetricsDashboard.tsx",
				now - 700
			);
			// Outside the requested window — must not count.
			await seedConflict(
				oldIssue.id,
				holdingIssue.id,
				"apps/api/src/routes/old.ts",
				now - 10 * 86400
			);

			const res = await getHeatmap({
				since: String(now - 3600),
				until: String(now),
				mode: "contention",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ContentionHeatmapResponse;

			expect(body.prefix).toBe("");
			expect(body.totalDistinctIssues).toBe(3);

			const apps = expectAppsGroup(body.entries);
			expect(apps.distinctRejectedIssueCount).toBe(3);
			expect(apps.conflictCount).toBe(4);
		});

		it("drills down via prefix, one segment at a time", async () => {
			const now = Math.floor(Date.now() / 1000);
			const holdingIssue = await seedIssue(workspaceId, projectId, userId, { title: "Holder" });
			const issueA = await seedIssue(workspaceId, projectId, userId, { title: "A" });
			const issueB = await seedIssue(workspaceId, projectId, userId, { title: "B" });

			await seedConflict(
				issueA.id,
				holdingIssue.id,
				"apps/api/src/services/flow-metrics.ts",
				now - 100
			);
			await seedConflict(
				issueB.id,
				holdingIssue.id,
				"apps/api/src/services/code-heatmap.ts",
				now - 90
			);
			await seedConflict(
				issueA.id,
				holdingIssue.id,
				"apps/web/src/islands/MetricsDashboard.tsx",
				now - 80
			);

			const apiRes = await getHeatmap({
				since: String(now - 3600),
				until: String(now),
				prefix: "apps/api/src/services",
				mode: "contention",
			});
			expect(apiRes.status).toBe(200);
			const apiBody = (await apiRes.json()) as ContentionHeatmapResponse;
			expect(apiBody.prefix).toBe("apps/api/src/services");
			const paths = apiBody.entries.map((e) => e.path).sort();
			expect(paths).toEqual([
				"apps/api/src/services/code-heatmap.ts",
				"apps/api/src/services/flow-metrics.ts",
			]);
			expect(apiBody.entries.every((e) => e.isLeaf)).toBe(true);
			expect(apiBody.entries.every((e) => e.distinctRejectedIssueCount === 1)).toBe(true);
		});

		it("returns an empty entries array when no conflicts exist in the workspace", async () => {
			const now = Math.floor(Date.now() / 1000);
			const res = await getHeatmap({
				since: String(now - 3600),
				until: String(now),
				mode: "contention",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ContentionHeatmapResponse;
			expect(body.entries).toEqual([]);
			expect(body.totalDistinctIssues).toBe(0);
		});
	});
});
