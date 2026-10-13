// PROJ-1018: getIssue reads the issue row (visibility included) in one round trip and
// child rollup, custom fields and links in one batch, with no KV cache. updateIssue
// resolves a status from the cached status list without a D1 read.
//
// Round trips are counted the way issues-write-batching.test.ts counts them: each statement
// executed on its own counts once, and a whole db.batch() counts once.
//
// Measured with this counter (before -> after this ticket):
// - getIssue: owner 5 -> 2 on a cold KV cache, 3 -> 2 on a warm one (plus 1-2 KV ops,
//   now none); a member with a project grant 6 -> 2; by ref 3 -> 2.
// - updateIssue with a statusId already in the cached status list: 3 -> 2. A member update
//   with an assignee and custom fields stays at 5, but its parent, existing-row, assignee,
//   custom-field and agent-session reads now run concurrently, and the 1-3 KV deletes at
//   the end are gone.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLink } from "../services/issue-links";
import { getIssue, updateIssue } from "../services/issues";
import { listTaskStatuses } from "../services/task-statuses";
import type { ServiceCtx } from "../services/types";
import {
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedProjectFixture,
	seedTaskStatus,
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

type Fixture = Awaited<ReturnType<typeof seedProjectFixture>>;

function ctxFor(f: Fixture, role: string): ServiceCtx {
	return {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: f.workspaceId,
		userId: f.userId,
		role,
	} as ServiceCtx;
}

describe("PROJ-1018: getIssue in one batch, no issue KV cache", () => {
	let f: Fixture;
	let owner: ServiceCtx;
	let a: { id: string; number: number };
	let b: { id: string; number: number };

	beforeEach(async () => {
		f = await seedProjectFixture({ role: "owner" });
		owner = ctxFor(f, "owner");
		a = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "A" });
		b = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "B" });
		await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Child", parentId: a.id });
		const def = await seedCustomFieldDef(f.workspaceId, { key: "points", type: "number" });
		await seedCustomFieldValue(a.id, def.id, "3");
		await createLink(owner, { sourceIssueId: a.id, targetIssueId: b.id, type: "blocks" });
	});
	afterEach(() => vi.restoreAllMocks());

	async function measure(ctx: ServiceCtx, args: Record<string, unknown>) {
		const kvGet = vi.spyOn(env.KV, "get");
		const kvPut = vi.spyOn(env.KV, "put");
		const tracker = trackD1RoundTrips();
		const issue = await getIssue(ctx, args);
		const roundTrips = tracker.count();
		const kvCalls = kvGet.mock.calls.length + kvPut.mock.calls.length;
		vi.restoreAllMocks();
		return { issue, roundTrips, kvCalls };
	}

	function expectFullShape(issue: Record<string, unknown>) {
		expect(issue).toMatchObject({
			id: a.id,
			title: "A",
			rollup: { total: 1, remaining: 1 },
			customFields: [{ key: "points", value: "3" }],
			links: [{ linkedIssueId: b.id, linkedIssueTitle: "B", type: "blocks" }],
		});
	}

	it("owner by id: 2 round trips, no KV", async () => {
		const { issue, roundTrips, kvCalls } = await measure(owner, { id: a.id });
		expect(roundTrips).toBeLessThanOrEqual(2);
		expect(kvCalls).toBe(0);
		expectFullShape(issue);
	});

	it("owner by ref: 2 round trips", async () => {
		const { issue, roundTrips } = await measure(owner, { ref: `PROJ-${a.number}` });
		expect(roundTrips).toBeLessThanOrEqual(2);
		expectFullShape(issue);
	});

	it("member with a project grant: 2 round trips, same shape", async () => {
		await seedGroupGrant(f.workspaceId, f.userId, f.projectId, "member");
		const { issue, roundTrips } = await measure(ctxFor(f, "member"), { id: a.id });
		expect(roundTrips).toBeLessThanOrEqual(2);
		expectFullShape(issue);
	});

	it("member without a grant gets not found", async () => {
		await expect(getIssue(ctxFor(f, "member"), { id: a.id })).rejects.toThrow("Issue not found");
		await expect(getIssue(ctxFor(f, "member"), { ref: `PROJ-${a.number}` })).rejects.toThrow(
			"Issue not found"
		);
	});

	it("member does not see links to issues in a project they can't see", async () => {
		const hidden = await seedProject(f.workspaceId, "HID");
		const h = await seedIssue(f.workspaceId, hidden.id, f.userId, { title: "Hidden" });
		await createLink(owner, { sourceIssueId: h.id, targetIssueId: a.id, type: "blocks" });
		await seedGroupGrant(f.workspaceId, f.userId, f.projectId, "member");

		const asMember = await getIssue(ctxFor(f, "member"), { id: a.id });
		expect(
			(asMember.links as Array<{ linkedIssueId: string }>).map((l) => l.linkedIssueId)
		).toEqual([b.id]);
		const asOwner = await getIssue(owner, { id: a.id });
		expect(asOwner.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					linkedIssueId: h.id,
					type: "blocked_by",
					linkedIssueTitle: "Hidden",
				}),
			])
		);
	});

	it("writes no longer touch KV", async () => {
		const kvDelete = vi.spyOn(env.KV, "delete");
		await updateIssue(owner, a.id, { title: "Renamed" });
		expect(kvDelete).not.toHaveBeenCalled();
	});
});

describe("PROJ-1018: updateIssue resolves statuses from the cached list", () => {
	let f: Fixture;
	let owner: ServiceCtx;

	beforeEach(async () => {
		f = await seedProjectFixture({ role: "owner" });
		owner = ctxFor(f, "owner");
	});
	afterEach(() => vi.restoreAllMocks());

	it("a cached statusId costs no task_statuses read", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "S" });
		const doing = await seedTaskStatus(f.workspaceId, { key: "doing", category: "in_progress" });
		await listTaskStatuses(owner); // warm the status cache

		const tracker = trackD1RoundTrips();
		await updateIssue(owner, issue.id, { statusId: doing.id });
		const roundTrips = tracker.count();
		vi.restoreAllMocks();

		expect(roundTrips).toBeLessThanOrEqual(2);
		const row = await env.DB.prepare(
			"SELECT status, status_id, status_category FROM issues WHERE id = ?"
		)
			.bind(issue.id)
			.first();
		expect(row).toEqual({ status: "doing", status_id: doing.id, status_category: "in_progress" });
	});

	it("a status deleted while still cached is a validation error, and nothing is written", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Stale" });
		const gone = await seedTaskStatus(f.workspaceId, { key: "gone", category: "in_progress" });
		await listTaskStatuses(owner);
		await env.DB.prepare("DELETE FROM task_statuses WHERE id = ?").bind(gone.id).run();

		await expect(updateIssue(owner, issue.id, { statusId: gone.id })).rejects.toThrow(/Validation/);
		const row = await env.DB.prepare("SELECT status_id FROM issues WHERE id = ?")
			.bind(issue.id)
			.first();
		expect(row).toEqual({ status_id: null });
	});

	it("an issue the caller can't see is not found, even with an invalid assignee", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Hidden" });
		await expect(
			updateIssue(ctxFor(f, "member"), issue.id, { assigneeId: crypto.randomUUID() })
		).rejects.toThrow("Issue not found");
	});
});
