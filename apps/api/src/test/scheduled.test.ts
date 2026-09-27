import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeAllWorkspacesExpiredWikiPages, purgeExpiredRetentionData } from "../index";
import { authHeaders, seedAgentLease, seedFixture, seedIssueFixture } from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

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
