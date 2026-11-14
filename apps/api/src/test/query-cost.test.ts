import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveIssueIdParam, resolveVisibleIssueIdParam } from "../services/issue-ref";
import { createIssues, getIssue, getIssuesBatch, updateIssue } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import { seedProjectFixture } from "./helpers";

// PROJ-1099: guards against queries that read every issue in the workspace. A ref lookup
// (KEY-N) and get_issue's child rollup used to pick a workspace_id index and walk the
// whole workspace (about two rows read per issue) on every call, which is what used up
// D1's daily row-read allowance. These tests sum D1's own `meta.rows_read`, so they fail
// on the cost itself, whatever plan SQLite picks. The test database, like production
// after the migrations, has no sqlite_stat1 rows for these tables.

const ISSUES = 300;
// A full scan reads at least ISSUES rows; an index lookup reads a handful.
const POINT_LOOKUP_BUDGET = 40;

function countRowsRead() {
	let rows = 0;
	const origPrepare = env.DB.prepare.bind(env.DB);
	const origBatch = env.DB.batch.bind(env.DB);
	const add = (meta: { rows_read?: number } | undefined) => {
		rows += meta?.rows_read ?? 0;
	};
	const unwrap = (s: D1PreparedStatement) =>
		(s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s;

	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop) {
				if (prop === "__inner") return target;
				if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a));
				if (prop === "all" || prop === "run") {
					return async () => {
						const r = await target.all();
						add(r.meta);
						return r;
					};
				}
				// `first` and `raw` don't expose meta; read through `all` instead.
				if (prop === "first") {
					return async (col?: string) => {
						const r = await target.all<Record<string, unknown>>();
						add(r.meta);
						const row = r.results[0];
						return row === undefined ? null : col ? row[col] : row;
					};
				}
				if (prop === "raw") {
					return async (opts?: { columnNames?: boolean }) => {
						const r = await target.all<Record<string, unknown>>();
						add(r.meta);
						const rows = r.results.map((x) => Object.values(x));
						return opts?.columnNames ? [Object.keys(r.results[0] ?? {}), ...rows] : rows;
					};
				}
				const v = Reflect.get(target, prop);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});

	vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => wrap(origPrepare(q)));
	vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
		const results = await origBatch(stmts.map(unwrap));
		for (const r of results) add(r.meta);
		return results;
	});
	return () => rows;
}

describe("PROJ-1099: issue lookups read a bounded number of rows", () => {
	let ctx: ServiceCtx;
	let parentId: string;
	const ids: string[] = [];

	beforeAll(async () => {
		const f = await seedProjectFixture({ role: "owner" });
		ctx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: f.workspaceId,
			userId: f.userId,
			role: "owner",
		} as ServiceCtx;
		for (let i = 0; i < ISSUES; i += 50) {
			const { results } = (await createIssues(ctx, {
				projectId: f.projectId,
				items: Array.from({ length: 50 }, (_, j) => ({ title: `issue ${i + j + 1}` })),
			})) as { results: Array<{ id: string }> };
			ids.push(...results.map((r) => r.id));
		}
		parentId = ids[0];
		for (const child of ids.slice(1, 4)) {
			await updateIssue(ctx, child, { parentId });
		}
	});
	afterEach(() => vi.restoreAllMocks());

	it("resolveIssueIdParam resolves a ref without scanning the workspace", async () => {
		const rowsRead = countRowsRead();
		expect(await resolveIssueIdParam(ctx, "PROJ-150")).toBe(ids[149]);
		expect(rowsRead()).toBeLessThan(POINT_LOOKUP_BUDGET);
	});

	it("resolveVisibleIssueIdParam resolves a ref without scanning the workspace", async () => {
		const rowsRead = countRowsRead();
		expect(await resolveVisibleIssueIdParam(ctx, "PROJ-299")).toBe(ids[298]);
		expect(rowsRead()).toBeLessThan(POINT_LOOKUP_BUDGET);
	});

	it("an unknown ref is still not found, and still cheap", async () => {
		const rowsRead = countRowsRead();
		await expect(resolveIssueIdParam(ctx, "PROJ-9999")).rejects.toThrow("Issue not found");
		expect(rowsRead()).toBeLessThan(POINT_LOOKUP_BUDGET);
	});

	it("get_issue by ref, including the child rollup, reads a bounded number of rows", async () => {
		const rowsRead = countRowsRead();
		const issue = (await getIssue(ctx, { id: "PROJ-1" })) as {
			id: string;
			rollup: { total: number };
		};
		expect(issue.id).toBe(parentId);
		expect(issue.rollup.total).toBe(3);
		expect(rowsRead()).toBeLessThan(POINT_LOOKUP_BUDGET);
	});

	it("get_issues with ten refs reads a bounded number of rows", async () => {
		const refs = Array.from({ length: 10 }, (_, i) => `PROJ-${(i + 1) * 25}`);
		const rowsRead = countRowsRead();
		const { items } = (await getIssuesBatch(ctx, { ids: refs })) as unknown as {
			items: Array<{ id: string }>;
		};
		expect(items.map((i) => i.id)).toEqual(refs.map((_, i) => ids[(i + 1) * 25 - 1]));
		// Ten point lookups plus the batched loads; a scan would be over ISSUES on its own.
		expect(rowsRead()).toBeLessThan(ISSUES / 2);
	});

	it("a ref in another workspace does not resolve", async () => {
		const other = await seedProjectFixture({ role: "owner" });
		const otherCtx = { ...ctx, workspaceId: other.workspaceId } as ServiceCtx;
		await expect(resolveIssueIdParam(otherCtx, "PROJ-150")).rejects.toThrow("Issue not found");
	});
});
