// PROJ-819/918: deleteProject must clean up everything under the project explicitly —
// D1 doesn't guarantee the FK cascades (PROJ-407). Runs with foreign keys OFF so the
// test SQLite's own cascades can't mask missing app-level cleanup.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceCtx } from "../services/types";
import { createWikiPage, updateWikiPage } from "../services/wiki";
import {
	authHeaders,
	seedAgentLease,
	seedComment,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedProject,
} from "./helpers";

async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("PROJ-819: deleteProject cleans up explicitly", () => {
	beforeEach(async () => {
		await env.DB.prepare("PRAGMA foreign_keys = OFF").run();
	});
	afterEach(async () => {
		await env.DB.prepare("PRAGMA foreign_keys = ON").run();
	});

	it("removes the project's issues, wiki pages and their dependents; detaches outside references", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: workspace.id,
			userId: user.id,
			role: "owner",
		};
		const doomed = await seedProject(workspace.id, "DOOM");
		const other = await seedProject(workspace.id, "KEEP");

		const issue = await seedIssue(workspace.id, doomed.id, user.id, { title: "Doomed issue" });
		await seedComment(issue.id, user.id);
		await seedAgentLease(workspace.id, issue.id);
		const field = await seedCustomFieldDef(workspace.id, { key: "risk", projectId: doomed.id });
		await seedCustomFieldValue(issue.id, field.id, "v");
		const child = await seedIssue(workspace.id, other.id, user.id, {
			title: "Child elsewhere",
			parentId: issue.id,
		});
		await seedGroupGrant(workspace.id, user.id, doomed.id);
		await env.DB.prepare(
			"INSERT INTO sprints (id, workspace_id, project_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'S1', 'planned', 0, 0)"
		)
			.bind(crypto.randomUUID(), workspace.id, doomed.id)
			.run();

		const page = (await createWikiPage(ctx, {
			title: "Doomed Page",
			content: "v1",
			projectId: doomed.id,
		})) as { id: string; slug: string };
		await updateWikiPage(ctx, page.slug, { content: "v2" });
		const linker = (await createWikiPage(ctx, {
			title: "Linker",
			content: "[[Doomed Page]]",
			projectId: other.id,
		})) as { id: string };

		const res = await SELF.fetch(`http://localhost/api/projects/${doomed.id}`, {
			method: "DELETE",
			headers: authHeaders(token, workspace.slug),
		});
		expect(res.status).toBe(200);

		expect(await count("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?", doomed.id)).toBe(0);
		expect(
			await count("SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?", issue.id)
		).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM issue_leases WHERE issue_id = ?", issue.id)).toBe(
			0
		);
		expect(
			await count("SELECT COUNT(*) AS n FROM custom_field_values WHERE issue_id = ?", issue.id)
		).toBe(0);
		expect(
			await count("SELECT COUNT(*) AS n FROM custom_field_definitions WHERE id = ?", field.id)
		).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM issues_fts WHERE issue_id = ?", issue.id)).toBe(
			0
		);
		expect(await count("SELECT COUNT(*) AS n FROM sprints WHERE project_id = ?", doomed.id)).toBe(
			0
		);
		expect(
			await count("SELECT COUNT(*) AS n FROM group_project_grants WHERE project_id = ?", doomed.id)
		).toBe(0);
		expect(
			await count("SELECT COUNT(*) AS n FROM wiki_pages WHERE project_id = ?", doomed.id)
		).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM wiki_revisions WHERE page_id = ?", page.id)).toBe(
			0
		);
		expect(await count("SELECT COUNT(*) AS n FROM wiki_fts WHERE page_id = ?", page.id)).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", doomed.id)).toBe(0);

		// Outside references are detached, not left dangling.
		const childRow = await env.DB.prepare("SELECT parent_id AS p FROM issues WHERE id = ?")
			.bind(child.id)
			.first<{ p: string | null }>();
		expect(childRow?.p).toBeNull();
		const link = await env.DB.prepare(
			"SELECT target_page_id AS t FROM wiki_links WHERE source_page_id = ?"
		)
			.bind(linker.id)
			.first<{ t: string | null }>();
		expect(link?.t).toBeNull();
	});

	it("404s for another workspace's project", async () => {
		const a = await seedFixture({ role: "owner" });
		const b = await seedFixture({ role: "owner" });
		const bProject = await seedProject(b.workspace.id, "BBB");
		const res = await SELF.fetch(`http://localhost/api/projects/${bProject.id}`, {
			method: "DELETE",
			headers: authHeaders(a.token, a.workspace.slug),
		});
		expect(res.status).toBe(404);
		expect(await count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", bProject.id)).toBe(1);
	});
});
