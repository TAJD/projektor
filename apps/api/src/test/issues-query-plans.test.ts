import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue, getPrioritizedIssues, listIssues, searchIssues } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import { seedProjectFixture } from "./helpers";

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
});
