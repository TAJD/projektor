import { env, SELF } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
	purgeAllWorkspacesExpiredWikiPages,
	purgeExpiredRetentionData,
	runFtsDedupeOnce,
} from "../index";
import {
	authHeaders,
	seedAgentLease,
	seedFixture,
	seedIssueFixture,
	seedUser,
	seedWorkspace,
} from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

// PROJ-865: counts every real D1 statement execution (.all/.first/.raw/.run, .batch as
// one) and every R2/KV call made through a wrapped `env`, so a test can assert on the
// actual number of subrequests a call made — independent of (and a check on) the
// production code's own internal budget accounting in index.ts.
function countSubrequests(realEnv: typeof env): { env: Env; count: () => number } {
	let used = 0;
	const bump = () => {
		used++;
	};
	const wrapD1 = (db: D1Database): D1Database =>
		new Proxy(db, {
			get(dbTarget, dbProp, dbReceiver) {
				if (dbProp === "prepare") {
					return (sql: string) => {
						const stmt = Reflect.get(dbTarget, "prepare", dbReceiver).call(dbTarget, sql);
						return new Proxy(stmt, {
							get(stmtTarget, stmtProp, stmtReceiver) {
								if (stmtProp === "bind") {
									return (...args: unknown[]) => {
										const bound = Reflect.get(stmtTarget, "bind", stmtReceiver).call(
											stmtTarget,
											...args
										);
										return new Proxy(bound, {
											get(boundTarget, boundProp, boundReceiver) {
												const orig = Reflect.get(boundTarget, boundProp, boundReceiver);
												if (
													typeof boundProp === "string" &&
													["all", "first", "raw", "run"].includes(boundProp)
												) {
													return async (...a: unknown[]) => {
														bump();
														return await orig.apply(boundTarget, a);
													};
												}
												return typeof orig === "function" ? orig.bind(boundTarget) : orig;
											},
										});
									};
								}
								const orig = Reflect.get(stmtTarget, stmtProp, stmtReceiver);
								return typeof orig === "function" ? orig.bind(stmtTarget) : orig;
							},
						});
					};
				}
				if (dbProp === "batch") {
					return async (statements: D1PreparedStatement[]) => {
						bump();
						return await Reflect.get(dbTarget, "batch", dbReceiver).call(dbTarget, statements);
					};
				}
				const orig = Reflect.get(dbTarget, dbProp, dbReceiver);
				return typeof orig === "function" ? orig.bind(dbTarget) : orig;
			},
		});
	const wrapCalls = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(t, prop, receiver) {
				const orig = Reflect.get(t, prop, receiver);
				if (typeof orig !== "function") return orig;
				return (...args: unknown[]) => {
					bump();
					return orig.apply(t, args);
				};
			},
		});

	const wrappedEnv = {
		...realEnv,
		DB: wrapD1(realEnv.DB),
		R2: wrapCalls(realEnv.R2),
		KV: wrapCalls(realEnv.KV),
	} as unknown as Env;
	return { env: wrappedEnv, count: () => used };
}

// PROJ-496: the Workers Cron Trigger itself can't be exercised locally (no local cron
// firing in dev/test), so this calls the exported `purgeAllWorkspacesExpiredWikiPages`
// helper directly — the same function the `scheduled` handler in index.ts invokes on
// its daily fire — with the real test env, mirroring how the REST/MCP purge tests seed
// and backdate trash.
describe("scheduled wiki trash purge (PROJ-496)", () => {
	let token: string;
	let slug: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		slug = fixture.workspace.slug;
	});

	async function req(url: string, opts?: RequestInit) {
		await resetRateLimits();
		return SELF.fetch(url, opts);
	}

	it("purges expired trash across every workspace, leaving unexpired trash untouched", async () => {
		const other = await seedFixture({ role: "admin" });

		const pageRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Scheduled Purge Page", content: "content" }),
		});
		const page = (await pageRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		await env.DB.prepare("UPDATE wiki_pages SET deleted_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, page.id)
			.run();

		const otherPageRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Scheduled Purge Other Page", content: "content" }),
		});
		const otherPage = (await otherPageRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${otherPage.slug}`, {
			method: "DELETE",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		// Not backdated — still inside the retention window.

		await purgeAllWorkspacesExpiredWikiPages(env);

		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(page.id).first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(otherPage.id).first()
		).not.toBeNull();
	});

	it("does not throw when a workspace has no expired trash", async () => {
		await expect(purgeAllWorkspacesExpiredWikiPages(env)).resolves.toBeUndefined();
	});
});

// PROJ-869: retention for wiki_notifications, ended agent_sessions (only ones no
// issue_leases row references), and the activity log — each pruned only once past its own
// window, and left alone otherwise. issue_leases is never pruned by age (post-review
// correction): flow metrics read old leases for lease-held time and lease expiries.
describe("scheduled retention purge (PROJ-869)", () => {
	const now = () => Math.floor(Date.now() / 1000);
	const DAY = 24 * 60 * 60;

	it("deletes only rows older than each category's retention window", async () => {
		const fixture = await seedIssueFixture({ role: "admin" });
		const { workspaceId, userId, issueId } = fixture;

		// wiki_notifications: one older than 90 days, one recent.
		const expiredNotificationId = crypto.randomUUID();
		const freshNotificationId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO wiki_notifications
			   (id, workspace_id, user_id, page_id, page_slug, page_title, action, actor_id, summary, created_at)
			 VALUES (?, ?, ?, 'p1', 'p1', 'P1', 'updated', NULL, 'x', ?)`
		)
			.bind(expiredNotificationId, workspaceId, userId, now() - 91 * DAY)
			.run();
		await env.DB.prepare(
			`INSERT INTO wiki_notifications
			   (id, workspace_id, user_id, page_id, page_slug, page_title, action, actor_id, summary, created_at)
			 VALUES (?, ?, ?, 'p2', 'p2', 'P2', 'updated', NULL, 'x', ?)`
		)
			.bind(freshNotificationId, workspaceId, userId, now() - 1 * DAY)
			.run();

		// agent_sessions: one ended 91 days ago with NO lease (should be purged), one ended
		// 91 days ago that STILL has a lease (must survive — flow metrics need it), one live.
		const expiredNoLeaseId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO agent_sessions
			   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, NULL, NULL, 'no-lease-session', 'agent', 'ended', ?, ?, ?)`
		)
			.bind(expiredNoLeaseId, workspaceId, now() - 100 * DAY, now() - 100 * DAY, now() - 91 * DAY)
			.run();

		const expiredWithLease = await seedAgentLease(workspaceId, issueId, { live: false });
		await env.DB.prepare("UPDATE agent_sessions SET ended_at = ? WHERE id = ?")
			.bind(now() - 91 * DAY, expiredWithLease.agentSessionId)
			.run();
		await env.DB.prepare("UPDATE issue_leases SET released_at = ? WHERE id = ?")
			.bind(now() - 91 * DAY, expiredWithLease.leaseId)
			.run();
		const live = await seedAgentLease(workspaceId, issueId, { live: true });

		// activity: one older than 1 year, one recent.
		const expiredActivityId = crypto.randomUUID();
		const freshActivityId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO activity (id, workspace_id, entity_type, entity_id, actor_id, action, diff, created_at)
			 VALUES (?, ?, 'issue', ?, ?, 'updated', NULL, ?)`
		)
			.bind(expiredActivityId, workspaceId, issueId, userId, now() - 366 * DAY)
			.run();
		await env.DB.prepare(
			`INSERT INTO activity (id, workspace_id, entity_type, entity_id, actor_id, action, diff, created_at)
			 VALUES (?, ?, 'issue', ?, ?, 'updated', NULL, ?)`
		)
			.bind(freshActivityId, workspaceId, issueId, userId, now() - 1 * DAY)
			.run();

		await purgeExpiredRetentionData(env);

		expect(
			await env.DB.prepare("SELECT id FROM wiki_notifications WHERE id = ?")
				.bind(expiredNotificationId)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM wiki_notifications WHERE id = ?")
				.bind(freshNotificationId)
				.first()
		).not.toBeNull();

		// The lease-less expired session is purged.
		expect(
			await env.DB.prepare("SELECT id FROM agent_sessions WHERE id = ?")
				.bind(expiredNoLeaseId)
				.first()
		).toBeNull();

		// PROJ-869 (must-fix): an old ended session that STILL has a lease survives, and so
		// does its lease — issue_leases is never pruned by age, and the NOT EXISTS clause on
		// agent_sessions keeps any session a lease still references.
		expect(
			await env.DB.prepare("SELECT id FROM issue_leases WHERE id = ?")
				.bind(expiredWithLease.leaseId)
				.first()
		).not.toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM agent_sessions WHERE id = ?")
				.bind(expiredWithLease.agentSessionId)
				.first()
		).not.toBeNull();

		expect(
			await env.DB.prepare("SELECT id FROM issue_leases WHERE id = ?").bind(live.leaseId).first()
		).not.toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM agent_sessions WHERE id = ?")
				.bind(live.agentSessionId)
				.first()
		).not.toBeNull();

		expect(
			await env.DB.prepare("SELECT id FROM activity WHERE id = ?").bind(expiredActivityId).first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM activity WHERE id = ?").bind(freshActivityId).first()
		).not.toBeNull();
	});

	it("does not throw when there is nothing expired", async () => {
		await expect(purgeExpiredRetentionData(env)).resolves.toBeUndefined();
	});
});

// PROJ-865: the daily cron's wiki-trash purge must scale with the number of workspaces
// that actually have expired trash, not the number of workspaces in the instance, and
// must never risk the Workers per-invocation subrequest ceiling regardless of backlog
// size — bounding the work per invocation via a budget + KV cursor instead.
describe("scheduled wiki trash purge scaling (PROJ-865)", () => {
	const EXPIRED_AT = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60; // well past the 30-day retention

	it("50 workspaces / 300 expired pages / 100 files: each invocation stays within 100 subrequests, and repeated invocations purge everything", async () => {
		const creator = await seedUser(`cron-purge-${crypto.randomUUID().slice(0, 8)}@example.com`);
		const workspaceIds: string[] = [];
		for (let i = 0; i < 50; i++) {
			const ws = await seedWorkspace(`cron-purge-ws-${i}-${crypto.randomUUID().slice(0, 6)}`);
			workspaceIds.push(ws.id);
		}

		const pageIds: string[] = [];
		const workspaceIdByPageId = new Map<string, string>();
		for (let i = 0; i < 300; i++) {
			const workspaceId = workspaceIds[i % workspaceIds.length];
			const id = crypto.randomUUID();
			workspaceIdByPageId.set(id, workspaceId);
			await env.DB.prepare(
				`INSERT INTO wiki_pages
				   (id, workspace_id, project_id, slug, title, content, parent_id,
				    created_by_id, updated_by_id, created_at, updated_at, version,
				    tags, owners, is_template, deleted_at, trash_batch_id)
				 VALUES (?, ?, NULL, ?, ?, '', NULL, ?, ?, ?, ?, 0, '[]', '[]', 0, ?, ?)`
			)
				.bind(
					id,
					workspaceId,
					`expired-page-${i}`,
					`Expired Page ${i}`,
					creator.id,
					creator.id,
					EXPIRED_AT,
					EXPIRED_AT,
					EXPIRED_AT,
					crypto.randomUUID()
				)
				.run();
			pageIds.push(id);
		}

		for (let i = 0; i < 100; i++) {
			const pageId = pageIds[i * 3]; // spread across ~1/3 of the pages
			const workspaceId = workspaceIdByPageId.get(pageId);
			if (!workspaceId) throw new Error(`no workspace recorded for page ${pageId}`);
			await env.DB.prepare(
				`INSERT INTO attachments
				   (id, workspace_id, kind, r2_key, filename, content_type, size, url,
				    linked_wiki_page_id, entity_type, entity_id, created_by_id, created_at)
				 VALUES (?, ?, 'file', ?, ?, 'text/plain', 3, NULL, NULL, 'wiki_page', ?, ?, ?)`
			)
				.bind(
					crypto.randomUUID(),
					workspaceId,
					`cron-purge-file-${i}`,
					`file-${i}.txt`,
					pageId,
					creator.id,
					EXPIRED_AT
				)
				.run();
		}

		// Run the real cron function repeatedly (as separate scheduled fires would),
		// checking every single invocation's subrequest count, until nothing is left.
		let iterations = 0;
		let remainingPages = 300;
		while (remainingPages > 0 && iterations < 20) {
			const { env: countedEnv, count } = countSubrequests(env);
			await purgeAllWorkspacesExpiredWikiPages(countedEnv);
			expect(count()).toBeLessThanOrEqual(100);
			iterations++;

			const row = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM wiki_pages WHERE deleted_at IS NOT NULL AND deleted_at < ?"
			)
				.bind(Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60)
				.first<{ n: number }>();
			remainingPages = row?.n ?? 0;
		}

		expect(remainingPages).toBe(0);
		const leftoverPages = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM wiki_pages WHERE id IN (SELECT value FROM json_each(?))"
		)
			.bind(JSON.stringify(pageIds))
			.first<{ n: number }>();
		expect(leftoverPages?.n ?? 0).toBe(0);
		const leftoverAttachments = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'wiki_page' AND entity_id IN (SELECT value FROM json_each(?))"
		)
			.bind(JSON.stringify(pageIds))
			.first<{ n: number }>();
		expect(leftoverAttachments?.n ?? 0).toBe(0);
	}, 60_000);

	// PROJ-865 (must-fix): purgeExpiredWikiPages itself must bound its own per-call work —
	// previously it selected every expired page in a workspace with no LIMIT, so a single
	// workspace with a large backlog could blow the subrequest budget in ONE workspace's
	// worth of work before the outer loop's per-workspace budget check ever got a chance to
	// stop it. A single workspace with 500 expired pages must therefore stay within budget
	// on every call, and the KV cursor must keep re-visiting that SAME workspace (instead of
	// moving on) until it's fully drained, since findWorkspacesWithExpiredTrash won't be
	// re-run while the cursor still lists it.
	it("1 workspace / 500 expired pages: every run stays within budget, repeated runs purge them all", async () => {
		const creator = await seedUser(
			`cron-purge-one-ws-${crypto.randomUUID().slice(0, 8)}@example.com`
		);
		const ws = await seedWorkspace(`cron-purge-one-ws-${crypto.randomUUID().slice(0, 6)}`);

		const pageIds: string[] = [];
		for (let i = 0; i < 500; i++) {
			const id = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO wiki_pages
				   (id, workspace_id, project_id, slug, title, content, parent_id,
				    created_by_id, updated_by_id, created_at, updated_at, version,
				    tags, owners, is_template, deleted_at, trash_batch_id)
				 VALUES (?, ?, NULL, ?, ?, '', NULL, ?, ?, ?, ?, 0, '[]', '[]', 0, ?, ?)`
			)
				.bind(
					id,
					ws.id,
					`one-ws-expired-page-${i}`,
					`One WS Expired Page ${i}`,
					creator.id,
					creator.id,
					EXPIRED_AT,
					EXPIRED_AT,
					EXPIRED_AT - i, // stagger deleted_at so ORDER BY is deterministic
					crypto.randomUUID()
				)
				.run();
			pageIds.push(id);
		}

		let iterations = 0;
		let remainingPages = 500;
		while (remainingPages > 0 && iterations < 20) {
			const { env: countedEnv, count } = countSubrequests(env);
			await purgeAllWorkspacesExpiredWikiPages(countedEnv);
			expect(count()).toBeLessThanOrEqual(100);
			iterations++;

			const row = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?"
			)
				.bind(ws.id, Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60)
				.first<{ n: number }>();
			remainingPages = row?.n ?? 0;
		}

		expect(remainingPages).toBe(0);
		expect(iterations).toBeGreaterThan(1); // 500 pages couldn't have drained in a single call
		const leftover = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM wiki_pages WHERE id IN (SELECT value FROM json_each(?))"
		)
			.bind(JSON.stringify(pageIds))
			.first<{ n: number }>();
		expect(leftover?.n ?? 0).toBe(0);
	}, 60_000);
});

// PROJ-816 follow-up: a one-off wiki_fts dedupe, guarded by a KV flag so it runs exactly
// once ever, removes stray FTS rows that pre-0065 worker code inserted during the deploy
// window with an auto-assigned rowid instead of the page's search_rowid.
describe("scheduled one-off wiki_fts dedupe (PROJ-816)", () => {
	it("removes a stray FTS row and runs the DELETE only once across repeated cron fires", async () => {
		await env.KV.delete("maint:fts-dedupe-0065");

		// A stray row: inserted with an auto rowid that no wiki_pages.search_rowid points at.
		await env.DB.prepare(
			"INSERT INTO wiki_fts(rowid, title, content) VALUES (999999999, 'stray', 'x')"
		).run();

		let ran = 0;
		const originalPrepare = env.DB.prepare.bind(env.DB);
		const spyEnv = {
			...env,
			DB: new Proxy(env.DB, {
				get(target, prop, receiver) {
					if (prop === "prepare") {
						return (sql: string) => {
							if (sql.includes("DELETE FROM wiki_fts WHERE rowid NOT IN")) ran++;
							return originalPrepare(sql);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}),
		} as unknown as Env;

		await runFtsDedupeOnce(spyEnv);
		await runFtsDedupeOnce(spyEnv); // second cron fire: must be a no-op, guarded by the KV flag

		expect(ran).toBe(1);
		expect(
			await env.DB.prepare("SELECT rowid FROM wiki_fts WHERE rowid = 999999999").first()
		).toBeNull();
		expect(await env.KV.get("maint:fts-dedupe-0065")).not.toBeNull();
	});
});
