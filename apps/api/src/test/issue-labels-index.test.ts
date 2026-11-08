import { env } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { describe, expect, it, vi } from "vitest";
import { runIssueLabelsResyncOnce } from "../index";
import {
	createIssue,
	deleteIssue,
	listIssues,
	searchIssues,
	updateIssue,
} from "../services/issues";
import { deleteProject } from "../services/projects";
import type { ServiceCtx } from "../services/types";
import { deleteWorkspace } from "../services/workspaces";
import { seedIssue, seedProject, seedProjectFixture } from "./helpers";

async function fixture() {
	const f = await seedProjectFixture({ role: "owner" });
	const ctx = {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: f.workspaceId,
		userId: f.userId,
		role: "owner",
	} as ServiceCtx;
	return { ...f, ctx };
}

async function indexed(issueId: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label"
	)
		.bind(issueId)
		.all<{ label: string }>();
	return results.map((r) => r.label);
}

async function plan(sqlText: string, ...params: unknown[]): Promise<string> {
	const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
		.bind(...params)
		.all<{ detail: string }>();
	return results.map((r) => r.detail).join("\n");
}

describe("PROJ-1070: issue_labels index", () => {
	it("follows create, label edits and delete", async () => {
		const { ctx, projectId } = await fixture();
		const issue = (await createIssue(ctx, {
			projectId,
			title: "Wombat",
			labels: ["alpha", "Beta"],
		})) as { id: string };
		expect(await indexed(issue.id)).toEqual(["Beta", "alpha"]);

		await updateIssue(ctx, issue.id, { title: "Wombat renamed" });
		expect(await indexed(issue.id)).toEqual(["Beta", "alpha"]);

		await updateIssue(ctx, issue.id, { labels: ["Beta", "gamma"] });
		expect(await indexed(issue.id)).toEqual(["Beta", "gamma"]);
		const byLabel = async (labels: string[]) =>
			(
				(await listIssues(ctx, { projectId, labels })) as unknown as {
					items: Array<{ id: string }>;
				}
			).items.map((i) => i.id);
		expect(await byLabel(["alpha"])).toEqual([]);
		expect(await byLabel(["gamma", "Beta"])).toEqual([issue.id]);
		expect(await byLabel(["beta"])).toEqual([]);
		const hits = (await searchIssues(ctx, { query: "BETA", projectId })) as Array<{ id: string }>;
		expect(hits.map((h) => h.id)).toEqual([issue.id]);

		await updateIssue(ctx, issue.id, { labels: [] });
		expect(await indexed(issue.id)).toEqual([]);

		await updateIssue(ctx, issue.id, { labels: ["delta"] });
		await deleteIssue(ctx, issue.id);
		expect(await indexed(issue.id)).toEqual([]);
	});

	it("is cleared by project and workspace deletes", async () => {
		const { ctx, workspaceId, slug, projectId } = await fixture();
		const doomed = await seedProject(workspaceId, "DOOM");
		const kept = await seedProject(workspaceId, "KEEP");
		const a = (await createIssue(ctx, { projectId: doomed.id, title: "a", labels: ["x"] })) as {
			id: string;
		};
		const b = (await createIssue(ctx, { projectId: kept.id, title: "b", labels: ["x"] })) as {
			id: string;
		};
		await deleteProject(ctx, doomed.id);
		expect(await indexed(a.id)).toEqual([]);
		expect(await indexed(b.id)).toEqual(["x"]);

		await deleteProject(ctx, kept.id);
		await deleteProject(ctx, projectId);
		await env.DB.prepare(
			"INSERT INTO issue_labels (issue_id, workspace_id, label) VALUES ('orphan', ?, 'x')"
		)
			.bind(workspaceId)
			.run();
		await deleteWorkspace(ctx, slug, "some-other-default");
		const left = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM issue_labels WHERE workspace_id = ?"
		)
			.bind(workspaceId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});

	it("filters: all-of, any-of and case-variant labels", async () => {
		const { ctx, projectId } = await fixture();
		const make = async (title: string, labels: string[]) =>
			((await createIssue(ctx, { projectId, title, labels })) as { id: string }).id;
		const both = await make("both", ["bug", "ui"]);
		const bugOnly = await make("bug only", ["bug"]);
		const variants = await make("variants", ["Bug", "bug"]);
		const ids = async (labels: string[], labelsMode?: "all" | "any") =>
			(
				(await listIssues(ctx, { projectId, labels, labelsMode })) as unknown as {
					items: Array<{ id: string }>;
					total: number;
				}
			).items
				.map((i) => i.id)
				.sort();
		expect(await ids(["bug", "ui"])).toEqual([both]);
		expect(await ids(["bug", "bug", "ui"])).toEqual([both]);
		expect(await ids(["bug", "Bug"])).toEqual([variants]);
		expect(await ids(["ui", "Bug"], "any")).toEqual([both, variants].sort());
		expect(await ids(["bug"])).toEqual([both, bugOnly, variants].sort());
		const hits = (await searchIssues(ctx, { query: "BUG", projectId })) as Array<{ id: string }>;
		expect(hits.map((h) => h.id).sort()).toEqual([both, bugOnly, variants].sort());
	});

	it("20 labels with 50 statusIds stay within D1's 100 bound parameters", async () => {
		const { ctx, projectId } = await fixture();
		let maxBound = 0;
		const originalPrepare = env.DB.prepare.bind(env.DB);
		const spy = vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			const stmt = originalPrepare(q);
			const bind = stmt.bind.bind(stmt);
			stmt.bind = (...args: unknown[]) => {
				maxBound = Math.max(maxBound, args.length);
				return bind(...args);
			};
			return stmt;
		});
		try {
			for (const labelsMode of ["all", "any"] as const) {
				await listIssues(ctx, {
					projectId,
					labels: Array.from({ length: 20 }, (_, n) => `l${n}`),
					labelsMode,
					statusIds: Array.from({ length: 50 }, () => crypto.randomUUID()).join(","),
				});
			}
		} finally {
			spy.mockRestore();
		}
		expect(maxBound).toBeGreaterThan(70);
		expect(maxBound).toBeLessThanOrEqual(100);
	});

	it("label search and label filters are served by issue_labels indexes", async () => {
		const { workspaceId, projectId } = await fixture();
		const search = await plan(
			`SELECT i.id FROM issues i LEFT JOIN projects p ON p.id = i.project_id
			 WHERE i.workspace_id = ?
			   AND i.id IN (SELECT issue_id FROM issue_labels WHERE workspace_id = ? AND lower(label) = lower(?))
			   AND i.project_id = ?
			 ORDER BY i.created_at DESC, i.id DESC LIMIT ?`,
			workspaceId,
			workspaceId,
			"bug",
			projectId,
			20
		);
		expect(search).toContain("idx_issue_labels_ws_label_lower");
		expect(search).not.toMatch(/SCAN i\b/);

		const filter = await plan(
			`select count(*) from "issues" where ("issues"."workspace_id" = ? and "issues"."project_id" = ?
			 and "issues"."id" IN (SELECT issue_id FROM issue_labels WHERE workspace_id = ? AND label IN (?, ?) GROUP BY issue_id HAVING COUNT(*) = 2))`,
			workspaceId,
			projectId,
			workspaceId,
			"bug",
			"ui"
		);
		expect(filter).toMatch(/idx_issue_labels_ws_label \(workspace_id=\? AND label=\?\)/);
	});

	it("the one-off resync rebuilds the index from issues.labels, once", async () => {
		await env.KV.delete("maint:issue-labels-resync-0079");
		const { workspaceId, projectId, userId } = await fixture();
		const stale = await seedIssue(workspaceId, projectId, userId, { title: "old worker" });
		await env.DB.prepare("UPDATE issues SET labels = ? WHERE id = ?")
			.bind(JSON.stringify(["fresh", 7]), stale.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO issue_labels (issue_id, workspace_id, label) VALUES (?, ?, 'gone')"
		)
			.bind(stale.id, workspaceId)
			.run();

		let rebuilds = 0;
		const originalPrepare = env.DB.prepare.bind(env.DB);
		const spyEnv = {
			...env,
			DB: new Proxy(env.DB, {
				get(target, prop, receiver) {
					if (prop === "prepare") {
						return (q: string) => {
							if (q === "DELETE FROM issue_labels") rebuilds++;
							return originalPrepare(q);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}),
		} as unknown as Env;
		await runIssueLabelsResyncOnce(spyEnv);
		await runIssueLabelsResyncOnce(spyEnv);

		expect(rebuilds).toBe(1);
		expect(await indexed(stale.id)).toEqual(["fresh"]);
	});
});
