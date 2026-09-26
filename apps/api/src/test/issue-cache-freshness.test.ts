// PROJ-863: GET of an issue never shows stale data about OTHER entities (linked
// issues, status/type names, project key, sprint) after those change.

import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getIssue } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedIssue, seedIssueFixture, seedTaskStatus } from "./helpers";

type IssueBody = {
	project_key: string;
	status_name: string | null;
	sprint_id: string | null;
	url: string;
	links: Array<{
		linkedIssueId: string;
		linkedIssueTitle: string;
		linkedIssueStatusCategory: string;
	}>;
};

let f: Awaited<ReturnType<typeof seedIssueFixture>>;
let otherId: string;

const call = (method: string, path: string, body?: unknown) =>
	SELF.fetch(`http://localhost${path}`, {
		method,
		headers: authHeaders(f.token, f.slug),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const get = async (id: string) =>
	(await (await call("GET", `/api/issues/${id}`)).json()) as IssueBody;

// These tests make more calls per token than wrangler.test.toml's RATE_LIMIT_API_MAX.
const prevApiMax = env.RATE_LIMIT_API_MAX;
beforeAll(() => {
	env.RATE_LIMIT_API_MAX = "1000";
});
afterAll(() => {
	env.RATE_LIMIT_API_MAX = prevApiMax;
});

beforeEach(async () => {
	f = await seedIssueFixture({ role: "owner" });
	otherId = (await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Other" })).id;
	const link = await call("POST", `/api/issues/${f.issueId}/links`, {
		targetIssueId: otherId,
		type: "blocks",
	});
	expect(link.status).toBeLessThan(300);
	await get(f.issueId); // warm the cache
});
afterEach(() => vi.restoreAllMocks());

describe("PROJ-863: no stale embedded data", () => {
	it("renaming the linked issue", async () => {
		await call("PATCH", `/api/issues/${otherId}`, { title: "Other (renamed)" });
		expect((await get(f.issueId)).links[0].linkedIssueTitle).toBe("Other (renamed)");
	});

	it("changing the linked issue's status", async () => {
		const todo = await seedTaskStatus(f.workspaceId, { category: "todo" });
		const done = await seedTaskStatus(f.workspaceId, { category: "done" });
		await env.DB.prepare("UPDATE issues SET status_id = ?, status_category = 'todo' WHERE id = ?")
			.bind(todo.id, otherId)
			.run();
		expect((await get(f.issueId)).links[0].linkedIssueStatusCategory).toBe("todo");
		await call("PATCH", `/api/issues/${otherId}`, { statusId: done.id });
		expect((await get(f.issueId)).links[0].linkedIssueStatusCategory).toBe("done");
	});

	it("deleting the linked issue", async () => {
		await call("DELETE", `/api/issues/${otherId}`);
		expect((await get(f.issueId)).links).toEqual([]);
	});

	it("renaming the issue's status", async () => {
		const st = await seedTaskStatus(f.workspaceId, { name: "Doing" });
		await env.DB.prepare("UPDATE issues SET status_id = ? WHERE id = ?")
			.bind(st.id, f.issueId)
			.run();
		expect((await get(f.issueId)).status_name).toBe("Doing");
		await call("PATCH", `/api/task-statuses/${st.id}`, { name: "In flight" });
		expect((await get(f.issueId)).status_name).toBe("In flight");
	});

	it("changing the project key", async () => {
		await call("PATCH", `/api/projects/${f.projectId}`, { key: "NEWK" });
		const issue = await get(f.issueId);
		expect(issue.project_key).toBe("NEWK");
		expect(issue.url).toContain("/NEWK/");
	});

	it("deleting the issue's sprint", async () => {
		const created = await call("POST", "/api/sprints", { projectId: f.projectId, name: "S1" });
		const sprint = (await created.json()) as { id: string };
		expect(created.status, JSON.stringify(sprint)).toBe(201);
		await env.DB.prepare("UPDATE issues SET sprint_id = ? WHERE id = ?")
			.bind(sprint.id, f.issueId)
			.run();
		expect((await get(f.issueId)).sprint_id).toBe(sprint.id);
		const del = await call("DELETE", `/api/sprints/${sprint.id}`);
		expect(del.status, await del.text()).toBe(200);
		const after = await get(f.issueId);
		expect(after.sprint_id, JSON.stringify(after).slice(0, 300)).toBeNull();
	});
});

describe("PROJ-863: a cache hit stays cheap", () => {
	it("getIssue by ref makes <= 5 D1 queries on a hit", async () => {
		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: f.workspaceId,
			userId: f.userId,
			role: "owner",
		};
		const { project_key, number } = (await getIssue(ctx, { id: f.issueId })) as {
			project_key: string;
			number: number;
		};
		let queries = 0;
		const orig = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			queries++;
			return orig(q);
		});
		await getIssue(ctx, { ref: `${project_key}-${number}` });
		expect(queries).toBeLessThanOrEqual(5);
	});
});
