// PROJ-922: deleteIssue must explicitly remove/null every row that references the
// deleted issue via an FK with ON DELETE CASCADE/SET NULL, since D1 does not guarantee
// FK enforcement (PROJ-407). Note: `PRAGMA foreign_keys = OFF` is a no-op on
// D1/Miniflare (it still reads 1), so FK-backed rows are also removed by the database's
// cascade here — those assertions are end-state checks. The non-FK references (share
// tokens, R2 objects, FTS) are what this proves; fk-cleanup.node.test.ts guards the rest.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedAgentLease,
	seedComment,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedIssue,
	seedProject,
} from "./helpers";

async function tableCount(sql: string, ...params: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("deleteIssue — dependent row cleanup (PROJ-922)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
	});

	it("removes or nulls every row referencing the deleted issue, and its R2 attachments", async () => {
		const { id: issueId } = await seedIssue(workspaceId, projectId, userId);
		const { id: otherIssueId } = await seedIssue(workspaceId, projectId, userId, {
			title: "Other issue",
		});
		const { id: childId } = await seedIssue(workspaceId, projectId, userId, {
			parentId: issueId,
			title: "Child issue",
		});

		// issue_comments (CASCADE)
		await seedComment(issueId, userId);

		// issue_links (CASCADE), both directions
		await env.DB.prepare(
			`INSERT INTO issue_links (id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at)
			 VALUES (?, ?, ?, ?, 'relates_to', ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				issueId,
				otherIssueId,
				userId,
				Math.floor(Date.now() / 1000)
			)
			.run();
		await env.DB.prepare(
			`INSERT INTO issue_links (id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at)
			 VALUES (?, ?, ?, ?, 'relates_to', ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				otherIssueId,
				issueId,
				userId,
				Math.floor(Date.now() / 1000)
			)
			.run();

		// custom_field_values (CASCADE)
		const field = await seedCustomFieldDef(workspaceId, { key: "severity" });
		await seedCustomFieldValue(issueId, field.id, "high");

		// issue_file_claims (CASCADE)
		await env.DB.prepare(
			`INSERT INTO issue_file_claims (id, workspace_id, issue_id, agent_id, path, claimed_at, released_at)
			 VALUES (?, ?, ?, NULL, ?, ?, NULL)`
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, "src/foo.ts", Math.floor(Date.now() / 1000))
			.run();

		// issue_leases (CASCADE) + agent_sessions.issue_id (SET NULL)
		const { agentSessionId } = await seedAgentLease(workspaceId, issueId);

		// claim_conflicts (CASCADE on both rejected_issue_id and holding_issue_id)
		await env.DB.prepare(
			`INSERT INTO claim_conflicts (id, workspace_id, path, rejected_issue_id, holding_issue_id, forced, occurred_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				"src/bar.ts",
				issueId,
				otherIssueId,
				Math.floor(Date.now() / 1000)
			)
			.run();

		// wip_cap_denials (CASCADE)
		await env.DB.prepare(
			`INSERT INTO wip_cap_denials (id, workspace_id, project_id, issue_id, agent_session_id, occurred_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				projectId,
				issueId,
				agentSessionId,
				Math.floor(Date.now() / 1000)
			)
			.run();

		// share_tokens (no FK at all)
		await env.DB.prepare(
			`INSERT INTO share_tokens (id, issue_id, workspace_id, created_by, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
			.bind(crypto.randomUUID(), issueId, workspaceId, "someone", 9999999999, 0)
			.run();

		// issue_gate_rejections (CASCADE)
		await env.DB.prepare(
			`INSERT INTO issue_gate_rejections (id, workspace_id, issue_id, occurred_at)
			 VALUES (?, ?, ?, ?)`
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, Math.floor(Date.now() / 1000))
			.run();

		// feedback.linked_issue_id (SET NULL) — needs a feedback_sources row first
		const sourceId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO feedback_sources (id, token_hash, workspace_id, project_id, name, is_active, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
		)
			.bind(
				sourceId,
				"hash",
				workspaceId,
				projectId,
				"Test source",
				userId,
				Math.floor(Date.now() / 1000)
			)
			.run();
		const feedbackId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO feedback (id, source_id, workspace_id, project_id, status, linked_issue_id, created_at)
			 VALUES (?, ?, ?, ?, 'actioned', ?, ?)`
		)
			.bind(feedbackId, sourceId, workspaceId, projectId, issueId, Math.floor(Date.now() / 1000))
			.run();

		// attachments (no physical FK, entity_type/entity_id polymorphic) — a real R2 object
		const form = new FormData();
		form.append("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
		form.append("entityType", "issue");
		form.append("entityId", issueId);
		const uploadRes = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(uploadRes.status).toBe(201);
		const { id: attachmentId } = (await uploadRes.json()) as { id: string };
		const r2Key = (
			await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?")
				.bind(attachmentId)
				.first<{ r2_key: string }>()
		)?.r2_key;
		expect(r2Key).toBeTruthy();
		expect(await env.R2.get(r2Key!)).not.toBeNull();

		// Sanity: every dependent row exists before delete.
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM issue_links WHERE source_issue_id = ? OR target_issue_id = ?",
				issueId,
				issueId
			)
		).toBe(2);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM custom_field_values WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_file_claims WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_leases WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM claim_conflicts WHERE rejected_issue_id = ? OR holding_issue_id = ?",
				issueId,
				issueId
			)
		).toBe(1);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM wip_cap_denials WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM issue_gate_rejections WHERE issue_id = ?",
				issueId
			)
		).toBe(1);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM agent_sessions WHERE issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM feedback WHERE linked_issue_id = ?", issueId)
		).toBe(1);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'issue' AND entity_id = ?",
				issueId
			)
		).toBe(1);
		expect(await tableCount("SELECT COUNT(*) AS n FROM issues WHERE parent_id = ?", issueId)).toBe(
			1
		);

		// --- act ---
		const deleteRes = await SELF.fetch(`http://localhost/api/issues/${issueId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(deleteRes.status).toBe(200);

		// --- assert: nothing references the deleted issue any more ---
		expect(
			await env.DB.prepare("SELECT id FROM issues WHERE id = ?").bind(issueId).first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT issue_id FROM issues_fts WHERE issue_id = ?")
				.bind(issueId)
				.first()
		).toBeNull();
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM share_tokens WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM issue_links WHERE source_issue_id = ? OR target_issue_id = ?",
				issueId,
				issueId
			)
		).toBe(0);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM custom_field_values WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_file_claims WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM issue_leases WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM claim_conflicts WHERE rejected_issue_id = ? OR holding_issue_id = ?",
				issueId,
				issueId
			)
		).toBe(0);
		expect(
			await tableCount("SELECT COUNT(*) AS n FROM wip_cap_denials WHERE issue_id = ?", issueId)
		).toBe(0);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM issue_gate_rejections WHERE issue_id = ?",
				issueId
			)
		).toBe(0);
		expect(
			await tableCount(
				"SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'issue' AND entity_id = ?",
				issueId
			)
		).toBe(0);

		// SET NULL rows: the row survives, the reference is cleared.
		const session = await env.DB.prepare("SELECT issue_id FROM agent_sessions WHERE id = ?")
			.bind(agentSessionId)
			.first<{ issue_id: string | null }>();
		expect(session).not.toBeNull();
		expect(session?.issue_id).toBeNull();

		const fb = await env.DB.prepare("SELECT linked_issue_id FROM feedback WHERE id = ?")
			.bind(feedbackId)
			.first<{ linked_issue_id: string | null }>();
		expect(fb).not.toBeNull();
		expect(fb?.linked_issue_id).toBeNull();

		const child = await env.DB.prepare("SELECT parent_id FROM issues WHERE id = ?")
			.bind(childId)
			.first<{ parent_id: string | null }>();
		expect(child).not.toBeNull();
		expect(child?.parent_id).toBeNull();

		// R2 object for the attachment is gone too.
		expect(await env.R2.get(r2Key!)).toBeNull();

		// The unrelated issue and its own row are untouched.
		expect(
			await env.DB.prepare("SELECT id FROM issues WHERE id = ?").bind(otherIssueId).first()
		).not.toBeNull();
	});
});

// PROJ-922 review: the dependent-row deletes key on the issue id, so deleting an id
// from ANOTHER workspace must be a 404 that touches nothing — not a silent wipe of that
// workspace's comments/links/attachments by an admin of this one.
describe("PROJ-922: deleteIssue refuses another workspace's issue", () => {
	it("404s and leaves the other workspace's rows intact", async () => {
		const { seedComment, seedIssue, seedProjectFixture, authHeaders } = await import("./helpers");
		const a = await seedProjectFixture({ role: "owner" });
		const b = await seedProjectFixture({ role: "owner" });
		const bIssue = await seedIssue(b.workspaceId, b.projectId, b.userId, { title: "B's" });
		await seedComment(bIssue.id, b.userId, "keep me");

		const res = await SELF.fetch(`http://localhost/api/issues/${bIssue.id}`, {
			method: "DELETE",
			headers: authHeaders(a.token, a.slug),
		});
		expect(res.status).toBe(404);
		const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?")
			.bind(bIssue.id)
			.first<{ n: number }>();
		expect(kept?.n).toBe(1);
	});
});
