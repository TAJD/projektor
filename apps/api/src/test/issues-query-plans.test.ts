import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue, getPrioritizedIssues, listIssues, searchIssues } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import {
	seedIssue,
	seedProject,
	seedProjectFixture,
	seedTaskStatus,
	seedTaskType,
	seedUser,
} from "./helpers";

function trackD1RoundTrips() {
	let count = 0;
	const origPrepare = env.DB.prepare.bind(env.DB);
	const origBatch = env.DB.batch.bind(env.DB);
	const EXEC_METHODS = new Set(["run", "all", "get", "first", "raw"]);

	const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...args: unknown[]) =>
						wrapStmt((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
				}
				if (typeof prop === "string" && EXEC_METHODS.has(prop)) {
					return (...args: unknown[]) => {
						count++;
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			},
		});

	vi.spyOn(env.DB, "prepare").mockImplementation(
		(q: string) => wrapStmt(origPrepare(q)) as D1PreparedStatement
	);
	vi.spyOn(env.DB, "batch").mockImplementation((stmts: D1PreparedStatement[]) => {
		count++;
		return origBatch(stmts);
	});

	return { count: () => count };
}

describe("PROJ-1020: query plans and batching", () => {
	let ctx: ServiceCtx;
	let f: Awaited<ReturnType<typeof seedProjectFixture>>;

	beforeEach(async () => {
		f = await seedProjectFixture({ role: "owner" });
		ctx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: f.workspaceId,
			userId: f.userId,
			role: "owner",
		} as ServiceCtx;
		for (let n = 0; n < 3; n++) {
			await createIssue(ctx, { projectId: f.projectId, title: `login bug ${n}` });
		}
	});
	afterEach(() => vi.restoreAllMocks());

	it("the DoR heal SELECT uses the partial dor_ready index", async () => {
		const { results } = await env.DB.prepare(
			"EXPLAIN QUERY PLAN SELECT id, body FROM issues WHERE workspace_id = ? AND dor_ready IS NULL LIMIT ?"
		)
			.bind(f.workspaceId, 200)
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join("\n");
		expect(plan).toContain("idx_issues_dor_ready_null");
	});

	it("the listIssues status+project total is a covering index lookup (PROJ-1071)", async () => {
		const { results } = await env.DB.prepare(
			`EXPLAIN QUERY PLAN select count(*) from "issues"
			 where ("issues"."workspace_id" = ? and "issues"."status" = ? and "issues"."project_id" = ?)`
		)
			.bind(f.workspaceId, "todo", f.projectId)
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join("\n");
		expect(plan).toContain("COVERING INDEX idx_issues_ws_project_status");
	});

	it("get_prioritized_issues scans only open issues through the partial index", async () => {
		let captured: { sql: string; args: unknown[] } | null = null;
		const origPrepare = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			const stmt = origPrepare(q);
			if (!q.includes("WITH open AS")) return stmt;
			const origBind = stmt.bind.bind(stmt);
			stmt.bind = (...args: unknown[]) => {
				captured = { sql: q, args };
				return origBind(...args);
			};
			return stmt;
		});
		await getPrioritizedIssues(ctx, { includeNotReady: true });
		vi.restoreAllMocks();
		expect(captured).not.toBeNull();
		const { sql, args } = captured as unknown as { sql: string; args: unknown[] };
		const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.bind(...args)
			.all<{ detail: string }>();
		expect(results.map((r) => r.detail).join("\n")).toContain("idx_issues_open_by_workspace");
	});

	it("searchIssues runs the label scan and FTS query in one round trip", async () => {
		const tracker = trackD1RoundTrips();
		const hits = await searchIssues(ctx, { query: "login" });
		const roundTrips = tracker.count();
		vi.restoreAllMocks();
		expect(hits.length).toBe(3);
		expect(roundTrips).toBe(1);
	});

	it("listIssues issues COUNT and rows concurrently on the first page only", async () => {
		const first = trackD1RoundTrips();
		const page = (await listIssues(ctx, { projectId: f.projectId, limit: 2 })) as {
			total: number | null;
			nextCursor: string | null;
		};
		const firstTrips = first.count();
		vi.restoreAllMocks();
		expect(page.total).toBe(3);

		const rest = trackD1RoundTrips();
		const next = (await listIssues(ctx, {
			projectId: f.projectId,
			limit: 2,
			cursor: page.nextCursor,
		})) as { total: number | null };
		const restTrips = rest.count();
		vi.restoreAllMocks();
		expect(next.total).toBeNull();
		expect(firstTrips).toBe(restTrips + 1);
		expect(page.nextCursor).not.toBeNull();
	});

	it("a listIssues cursor page seeks created_at with bound parameters, not just the project (PROJ-1112)", async () => {
		const first = (await listIssues(ctx, { projectId: f.projectId, limit: 1 })) as {
			nextCursor: string;
		};
		const prepared: string[] = [];
		const origPrepare = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			prepared.push(q);
			return origPrepare(q);
		});
		const next = (await listIssues(ctx, {
			projectId: f.projectId,
			limit: 1,
			cursor: first.nextCursor,
		})) as { items: unknown[] };
		vi.restoreAllMocks();
		expect(next.items).toHaveLength(1);

		const pageSql = prepared.find((q) => q.includes("order by") && q.includes('"created_at" <'));
		expect(pageSql).toBeDefined();
		const placeholders = (pageSql?.match(/\?/g) ?? []).length;
		const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${pageSql}`)
			.bind(...Array.from({ length: placeholders }, () => 0))
			.all<{ detail: string }>();
		const issuesStep = results.map((r) => r.detail).find((d) => /SEARCH "?issues"? /.test(d));
		expect(issuesStep).toMatch(/created_at<\?/);
	});
});

describe("PROJ-1112: listIssues page resolves joined fields by batched lookup", () => {
	afterEach(() => vi.restoreAllMocks());

	async function seedPage() {
		const f = await seedProjectFixture({ role: "member" });
		const ctx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: f.workspaceId,
			userId: f.userId,
			role: "member",
		} as ServiceCtx;
		const hidden = await seedProject(f.workspaceId, "HID");
		const assignee = await seedUser(`a-${crypto.randomUUID().slice(0, 8)}@example.com`);
		const type = await seedTaskType(f.workspaceId, { key: "bug", name: "Bug" });
		const status = await seedTaskStatus(f.workspaceId, {
			key: "triage",
			name: "Triage",
			category: "in_progress",
		});
		const t = 1_700_000_000;
		const mk = (title: string, o: Parameters<typeof seedIssue>[3], n: number) =>
			seedIssue(f.workspaceId, f.projectId, f.userId, { title, createdAt: t + n, ...o });
		const assigned = await mk("assigned", { assigneeId: assignee.id }, 1);
		const unassigned = await mk("unassigned", {}, 2);
		const typed = await mk("typed", { typeId: type.id }, 3);
		const custom = await mk("custom", { statusId: status.id }, 4);
		const parent = await mk("parent", {}, 5);
		const child = await mk("child", { parentId: parent.id }, 6);
		const hiddenParent = await seedIssue(f.workspaceId, hidden.id, f.userId, {
			title: "hidden parent",
		});
		const orphan = await mk("orphan", { parentId: hiddenParent.id }, 7);
		return {
			f,
			ctx,
			assignee,
			type,
			status,
			assigned,
			unassigned,
			typed,
			custom,
			parent,
			child,
			orphan,
		};
	}

	it("returns the same joined fields and parent_ref as the joined query", async () => {
		const s = await seedPage();
		const page = (await listIssues(s.ctx, { projectId: s.f.projectId, limit: 50 })) as {
			items: Array<Record<string, unknown>>;
		};
		const byTitle = Object.fromEntries(page.items.map((i) => [i.title as string, i]));
		const base = {
			workspace_id: s.f.workspaceId,
			project_id: s.f.projectId,
			project_key: "PROJ",
			project_name: "Test Project",
			assignee_id: null,
			assignee_name: null,
			parent_id: null,
			parent_ref: null,
			type_id: null,
			type_key: null,
			type_name: null,
			status_id: null,
			status_category: null,
			status_key: null,
			status_name: null,
			status: "backlog",
			priority: "none",
			labels: "[]",
			sprint_id: null,
			created_by_id: s.f.userId,
			author_kind: null,
			created_at: expect.any(Number),
			updated_at: expect.any(Number),
			completed_at: null,
			needs_audit: expect.anything(),
			customFields: [],
		};
		const expected = (issue: { id: string; number: number }, title: string, o = {}) => ({
			...base,
			id: issue.id,
			number: issue.number,
			title,
			url: `/projects/PROJ/issues/${issue.number}/${title}`,
			...o,
		});
		expect(page.items).toHaveLength(7);
		expect(byTitle.assigned).toEqual(
			expected(s.assigned, "assigned", {
				assignee_id: s.assignee.id,
				assignee_name: "Test User",
			})
		);
		expect(byTitle.unassigned).toEqual(expected(s.unassigned, "unassigned"));
		expect(byTitle.typed).toEqual(
			expected(s.typed, "typed", { type_id: s.type.id, type_key: "bug", type_name: "Bug" })
		);
		expect(byTitle.custom).toEqual(
			expected(s.custom, "custom", {
				status_id: s.status.id,
				status_category: "in_progress",
				status_key: "triage",
				status_name: "Triage",
			})
		);
		expect(byTitle.parent).toEqual(expected(s.parent, "parent"));
		expect(byTitle.child).toEqual(
			expected(s.child, "child", {
				parent_id: s.parent.id,
				parent_ref: `PROJ-${s.parent.number}`,
			})
		);
		expect(byTitle.orphan).toEqual(
			expected(s.orphan, "orphan", { parent_id: expect.any(String), parent_ref: null })
		);
	});

	it("the page SQL has no joins or correlated parent subquery", async () => {
		const s = await seedPage();
		const prepared: string[] = [];
		const origPrepare = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			prepared.push(q);
			return origPrepare(q);
		});
		await listIssues(s.ctx, { projectId: s.f.projectId, limit: 50 });
		vi.restoreAllMocks();
		const pageSql = prepared.find((q) => q.includes("order by") && q.includes('from "issues"'));
		expect(pageSql).toBeDefined();
		expect(pageSql).not.toMatch(/left join/i);
		expect(pageSql).not.toContain("pp.key");
	});
});
