import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listProjectsAcrossWorkspaces } from "../services/projects";
import { seedDefaultTaskStatuses } from "../services/task-statuses";
import { authHeaders, seedIssue, seedProjectFixture, seedTaskStatus } from "./helpers";

async function categoryOf(issueId: string): Promise<string | undefined> {
	const row = await env.DB.prepare("SELECT status_category FROM issues WHERE id = ?")
		.bind(issueId)
		.first<{ status_category: string }>();
	return row?.status_category;
}

describe("PROJ-927: task_statuses.is_backlog", () => {
	it("the project tile counts issues on a custom is_backlog status, not just the 'backlog' key", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const icebox = await seedTaskStatus(f.workspaceId, { key: "icebox", isBacklog: true });
		const active = await seedTaskStatus(f.workspaceId, { key: "active" });
		await seedIssue(f.workspaceId, f.projectId, f.userId, {
			status: icebox.key,
			statusId: icebox.id,
		});
		await seedIssue(f.workspaceId, f.projectId, f.userId, {
			status: active.key,
			statusId: active.id,
		});
		await seedIssue(f.workspaceId, f.projectId, f.userId, { status: "backlog" });

		const rows = await listProjectsAcrossWorkspaces(f.userId, env.DB);
		const row = rows.find((r) => r.id === f.projectId);
		expect(row?.open_issue_count).toBe(3);
		expect(row?.backlog_issue_count).toBe(2);
	});

	it("a status keyed 'backlog' with the flag cleared no longer counts as backlog", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const status = await seedTaskStatus(f.workspaceId, { key: "backlog", isBacklog: false });
		await seedIssue(f.workspaceId, f.projectId, f.userId, {
			status: status.key,
			statusId: status.id,
		});

		const rows = await listProjectsAcrossWorkspaces(f.userId, env.DB);
		expect(rows.find((r) => r.id === f.projectId)?.backlog_issue_count).toBe(0);
	});

	it("default statuses seed the built-in backlog status with the flag", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await seedDefaultTaskStatuses(env.DB, f.workspaceId);
		const rows = await env.DB.prepare(
			"SELECT key, is_backlog FROM task_statuses WHERE workspace_id = ?"
		)
			.bind(f.workspaceId)
			.all<{ key: string; is_backlog: number }>();
		const flagged = rows.results.filter((r) => r.is_backlog === 1).map((r) => r.key);
		expect(flagged).toEqual(["backlog"]);
	});

	it("create_task_status and update_task_status set and clear isBacklog; list exposes is_backlog", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.slug);
		const createRes = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers,
			body: JSON.stringify({ key: "icebox", name: "Icebox", category: "todo", isBacklog: true }),
		});
		expect(createRes.status).toBe(201);
		const { id } = (await createRes.json()) as { id: string };

		const list = async () =>
			(
				(await (
					await SELF.fetch("http://localhost/api/task-statuses", { headers })
				).json()) as Array<{
					id: string;
					is_backlog: number;
				}>
			).find((s) => s.id === id);
		expect((await list())?.is_backlog).toBe(1);

		const patch = await SELF.fetch(`http://localhost/api/task-statuses/${id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ isBacklog: false }),
		});
		expect(patch.status).toBe(200);
		expect((await list())?.is_backlog).toBe(0);
	});
});

describe("PROJ-927: issues statusIds filter is bounded", () => {
	it("accepts 50 ids and rejects 51 with a 400 instead of a D1 parameter-cap 500", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID()).join(",");
		const get = (n: number) =>
			SELF.fetch(`http://localhost/api/issues?statusIds=${ids(n)}`, {
				headers: authHeaders(f.token, f.slug),
			});

		expect((await get(50)).status).toBe(200);
		expect((await get(51)).status).toBe(400);
	});
});

describe("PROJ-927: issues.status_category follows the task status on every write path", () => {
	it("create, update by statusId, update by status key and feedback conversion all stamp the category", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.slug);
		const review = await seedTaskStatus(f.workspaceId, {
			key: "legal_review",
			category: "in_progress",
		});
		await seedTaskStatus(f.workspaceId, { key: "done", category: "done" });
		const post = (body: unknown) =>
			SELF.fetch("http://localhost/api/issues", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

		const created = await post({
			projectId: f.projectId,
			title: "created on a custom status",
			statusId: review.id,
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(await categoryOf(id)).toBe("in_progress");

		const patch = (body: unknown) =>
			SELF.fetch(`http://localhost/api/issues/${id}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify(body),
			});
		const todo = await seedTaskStatus(f.workspaceId, { key: "triage", category: "todo" });
		expect((await patch({ statusId: todo.id })).status).toBe(200);
		expect(await categoryOf(id)).toBe("todo");

		expect((await patch({ status: "done" })).status).toBe(200);
		expect(await categoryOf(id)).toBe("done");

		const srcRes = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources`,
			{ method: "POST", headers, body: JSON.stringify({ name: "Widget" }) }
		);
		expect(srcRes.status).toBe(201);
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();
		const feedbackId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO feedback (id, source_id, workspace_id, project_id, body, status, created_at)
			 VALUES (?, ?, ?, ?, 'please fix', 'new', 100)`
		)
			.bind(feedbackId, src?.id, f.workspaceId, f.projectId)
			.run();
		const fallback = await seedTaskStatus(f.workspaceId, {
			key: "intake",
			category: "in_progress",
			isDefault: true,
		});
		const convert = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{ method: "POST", headers, body: JSON.stringify({ feedbackIds: [feedbackId] }) }
		);
		expect(convert.status).toBe(201);
		const { id: converted } = (await convert.json()) as { id: string };
		const row = await env.DB.prepare("SELECT status_category, status_id FROM issues WHERE id = ?")
			.bind(converted)
			.first<{ status_category: string; status_id: string | null }>();
		expect(row?.status_id).toBe(fallback.id);
		expect(row?.status_category).toBe("in_progress");
	});
});
