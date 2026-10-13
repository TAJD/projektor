// PROJ-1029: a parent's child rollup counts only children in projects the caller can see.
// A child may live in another project than its parent (validateParent only checks that the
// caller can see the parent), so a member of the parent's project alone must not learn
// that hidden work exists under it. Checked on getIssue and listIssues(includeRollups),
// over REST and MCP.

import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedProjectFixture,
	toolError,
} from "./helpers";

type Rollup = { total: number; done: number; remaining: number; byStatus: Record<string, number> };

describe("PROJ-1029: child rollups respect project visibility", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectA: string;
	let projectB: string;
	let parentId: string;

	beforeEach(async () => {
		// Member with a grant on project A only.
		({
			token,
			slug,
			workspaceId,
			userId,
			projectId: projectA,
		} = await seedProjectFixture({
			role: "member",
		}));
		projectB = (await seedProject(workspaceId, "HIDB")).id;
		parentId = (await seedIssue(workspaceId, projectA, userId, { title: "Parent" })).id;
		await seedIssue(workspaceId, projectA, userId, { title: "Visible child", parentId });
		await seedIssue(workspaceId, projectB, userId, { title: "Hidden child", parentId });
	});

	async function restGet(): Promise<Rollup> {
		const res = await SELF.fetch(`http://localhost/api/issues/${parentId}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { rollup: Rollup }).rollup;
	}

	async function restList(): Promise<Rollup> {
		const res = await SELF.fetch(
			`http://localhost/api/issues?projectId=${projectA}&includeRollups=true`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as
			| Array<{ id: string; rollup: Rollup }>
			| { items: Array<{ id: string; rollup: Rollup }> };
		const items = Array.isArray(body) ? body : body.items;
		const parent = items.find((i) => i.id === parentId);
		expect(parent).toBeDefined();
		return parent!.rollup;
	}

	async function mcp(name: string, args: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const json = await res.json();
		expect(toolError(json)).toBeUndefined();
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		return JSON.parse((json as any).result.content[0].text);
	}

	async function mcpGet(): Promise<Rollup> {
		return (await mcp("get_issue", { id: parentId, fields: ["rollup"] })).rollup;
	}

	async function mcpList(): Promise<Rollup> {
		const page = await mcp("list_issues", {
			projectId: projectA,
			includeRollups: true,
			fields: ["id", "rollup"],
		});
		return page.items.find((i: { id: string }) => i.id === parentId).rollup;
	}

	it("a member of the parent's project only does not count the hidden child", async () => {
		for (const rollup of [await restGet(), await restList(), await mcpGet(), await mcpList()]) {
			expect(rollup).toMatchObject({ total: 1, remaining: 1 });
		}
	});

	it("a member who can see both projects counts both children", async () => {
		await seedGroupGrant(workspaceId, userId, projectB, "viewer");
		for (const rollup of [await restGet(), await restList(), await mcpGet(), await mcpList()]) {
			expect(rollup).toMatchObject({ total: 2, remaining: 2 });
		}
	});

	it("an owner counts both children", async () => {
		const owner = await seedProjectFixture({ role: "owner" });
		const p = (await seedIssue(owner.workspaceId, owner.projectId, owner.userId, { title: "P" }))
			.id;
		const other = (await seedProject(owner.workspaceId, "OTHR")).id;
		await seedIssue(owner.workspaceId, owner.projectId, owner.userId, { title: "c1", parentId: p });
		await seedIssue(owner.workspaceId, other, owner.userId, { title: "c2", parentId: p });

		const res = await SELF.fetch(`http://localhost/api/issues/${p}`, {
			headers: authHeaders(owner.token, owner.slug),
		});
		expect(((await res.json()) as { rollup: Rollup }).rollup).toMatchObject({ total: 2 });

		const list = await SELF.fetch(
			`http://localhost/api/issues?projectId=${owner.projectId}&includeRollups=true`,
			{ headers: authHeaders(owner.token, owner.slug) }
		);
		const body = (await list.json()) as
			| Array<{ id: string; rollup: Rollup }>
			| { items: Array<{ id: string; rollup: Rollup }> };
		const items = Array.isArray(body) ? body : body.items;
		expect(items.find((i) => i.id === p)?.rollup).toMatchObject({ total: 2 });
	});
});
