import { env } from "cloudflare:test";

export async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function seedWorkspace(slug = `test-ws-${crypto.randomUUID().slice(0, 8)}`) {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
		.bind(id, "Test Workspace", slug, now)
		.run();
	return { id, slug };
}

export async function seedUser(email = "user@example.com") {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
		.bind(id, email, "Test User", now)
		.run();
	return { id, email };
}

export async function seedMember(workspaceId: string, userId: string, role = "member") {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		"INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
	)
		.bind(workspaceId, userId, role, now)
		.run();
}

export async function seedToken(
	workspaceId: string,
	userId: string,
	opts?: { scopes?: string[]; expiresAt?: number }
): Promise<string> {
	const raw = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
	const hash = await hashToken(raw);
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			crypto.randomUUID(),
			workspaceId,
			userId,
			"test-token",
			hash,
			JSON.stringify(opts?.scopes ?? ["*"]),
			opts?.expiresAt ?? null,
			now
		)
		.run();
	return raw;
}

/** Seed a user-scoped token (NULL workspace_id — valid across all the user's workspaces). */
export async function seedUserToken(
	userId: string,
	opts?: { scopes?: string[]; expiresAt?: number }
): Promise<string> {
	const raw = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
	const hash = await hashToken(raw);
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			crypto.randomUUID(),
			null,
			userId,
			"test-user-token",
			hash,
			JSON.stringify(opts?.scopes ?? ["*"]),
			opts?.expiresAt ?? null,
			now
		)
		.run();
	return raw;
}

export async function seedProject(workspaceId: string, key = "PROJ") {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		"INSERT INTO projects (id, workspace_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
	)
		.bind(id, workspaceId, "Test Project", key, now, now)
		.run();
	return { id, key };
}

/** Returns headers needed for every authenticated request */
export function authHeaders(token: string, slug: string) {
	return {
		Authorization: `Bearer ${token}`,
		"X-Workspace-Slug": slug,
		"Content-Type": "application/json",
	};
}

export async function seedComment(issueId: string, authorId: string, body = "Test comment") {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		"INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
	)
		.bind(id, issueId, authorId, body, now, now)
		.run();
	return { id, body };
}

export async function seedTaskType(
	workspaceId: string,
	opts?: { id?: string; key?: string; name?: string; isDefault?: boolean; position?: number }
) {
	const id = opts?.id ?? crypto.randomUUID();
	const key = opts?.key ?? `type-${id.slice(0, 8)}`;
	await env.DB.prepare(
		`INSERT INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
	)
		.bind(id, workspaceId, key, opts?.name ?? key, opts?.position ?? 0, opts?.isDefault ? 1 : 0)
		.run();
	return { id, key, name: opts?.name ?? key };
}

export async function seedTaskStatus(
	workspaceId: string,
	opts?: { key?: string; name?: string; category?: string; isDefault?: boolean; position?: number }
) {
	const id = crypto.randomUUID();
	const key = opts?.key ?? `status-${id.slice(0, 8)}`;
	await env.DB.prepare(
		`INSERT INTO task_statuses (id, workspace_id, key, name, category, color, position, is_default)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
	)
		.bind(
			id,
			workspaceId,
			key,
			opts?.name ?? key,
			opts?.category ?? "todo",
			opts?.position ?? 0,
			opts?.isDefault ? 1 : 0
		)
		.run();
	return { id, key, name: opts?.name ?? key };
}

export async function seedIssue(
	workspaceId: string,
	projectId: string,
	createdById: string,
	opts?: {
		title?: string;
		status?: string;
		statusId?: string;
		priority?: string;
		assigneeId?: string;
		parentId?: string;
		typeId?: string;
		createdAt?: number;
	}
) {
	const id = crypto.randomUUID();
	const now = opts?.createdAt ?? Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO issues (id, workspace_id, project_id, number, title, body, status, status_id, priority,
       assignee_id, labels, parent_id, type_id, created_by_id, created_at, updated_at)
     SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, '', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?
     FROM issues WHERE project_id = ?`
	)
		.bind(
			id,
			workspaceId,
			projectId,
			opts?.title ?? "Seeded issue",
			opts?.status ?? "backlog",
			opts?.statusId ?? null,
			opts?.priority ?? "none",
			opts?.assigneeId ?? null,
			opts?.parentId ?? null,
			opts?.typeId ?? null,
			createdById,
			now,
			now,
			projectId
		)
		.run();
	await env.DB.prepare(
		`UPDATE issues SET status_category = COALESCE((SELECT category FROM task_statuses WHERE id = ?), '') WHERE id = ?`
	)
		.bind(opts?.statusId ?? null, id)
		.run();
	const row = await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
		.bind(id)
		.first<{ number: number }>();
	return { id, number: row!.number, createdAt: now };
}

export async function seedCustomFieldDef(
	workspaceId: string,
	opts: {
		key: string;
		label?: string;
		type?: string;
		options?: string[];
		projectId?: string | null;
	}
) {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO custom_field_definitions (id, workspace_id, project_id, key, label, type, options, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspaceId,
			opts.projectId ?? null,
			opts.key,
			opts.label ?? opts.key,
			opts.type ?? "text",
			opts.options ? JSON.stringify(opts.options) : null,
			now
		)
		.run();
	return { id, key: opts.key };
}

export async function seedCustomFieldValue(issueId: string, fieldId: string, value: string) {
	await env.DB.prepare(
		`INSERT INTO custom_field_values (issue_id, field_id, value) VALUES (?, ?, ?)
     ON CONFLICT(issue_id, field_id) DO UPDATE SET value = excluded.value`
	)
		.bind(issueId, fieldId, value)
		.run();
}

/**
 * Seed an agent (or human) session plus an active issue lease directly, bypassing the
 * claim flow. `live: true` (default) means an active session heartbeating within the
 * TTL (a live lease); `live: false` means an ended session with a stale heartbeat (the
 * issue was agent-worked but no lease is currently live).
 */
export async function seedAgentLease(
	workspaceId: string,
	issueId: string,
	opts?: { kind?: "agent" | "human"; live?: boolean; name?: string }
): Promise<{ agentSessionId: string; leaseId: string }> {
	const now = Math.floor(Date.now() / 1000);
	const live = opts?.live ?? true;
	const agentSessionId = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO agent_sessions
       (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			agentSessionId,
			workspaceId,
			issueId,
			opts?.name ?? "seed-agent",
			opts?.kind ?? "agent",
			live ? "active" : "ended",
			now,
			live ? now : now - 1000,
			live ? null : now
		)
		.run();
	const leaseId = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			leaseId,
			workspaceId,
			issueId,
			agentSessionId,
			now,
			live ? null : now,
			live ? null : "agent_ended"
		)
		.run();
	return { agentSessionId, leaseId };
}

/** Seed a complete workspace + user + member + token in one call */
export async function seedFixture(opts?: { slug?: string; email?: string; role?: string }) {
	const workspace = await seedWorkspace(opts?.slug ?? `ws-${crypto.randomUUID().slice(0, 8)}`);
	const user = await seedUser(opts?.email ?? `u-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(workspace.id, user.id, opts?.role ?? "member");
	const token = await seedToken(workspace.id, user.id);
	return { workspace, user, token };
}

/** Seed a workspace fixture plus a project in it — the common `beforeEach` shape across API tests. */
export async function seedProjectFixture(opts?: { role?: string }) {
	const fixture = await seedFixture({ role: opts?.role });
	const project = await seedProject(fixture.workspace.id);
	return {
		token: fixture.token,
		slug: fixture.workspace.slug,
		workspaceId: fixture.workspace.id,
		userId: fixture.user.id,
		projectId: project.id,
	};
}

/** Seed a project fixture plus an issue in it. */
export async function seedIssueFixture(opts?: { role?: string; issueTitle?: string }) {
	const base = await seedProjectFixture({ role: opts?.role });
	const issue = await seedIssue(base.workspaceId, base.projectId, base.userId, {
		title: opts?.issueTitle ?? "Test Issue",
	});
	return { ...base, issueId: issue.id };
}

/**
 * Seed a single workspace with owner, member, and viewer principals — each with their own token.
 * Used by authorization tests that need to assert role-based 403s within the same workspace.
 *
 * Scaffolding note: when scopes are enforced at the middleware level, extend each seedToken call
 * here (or in individual tests) with the opts.scopes parameter to exercise restricted-scope paths.
 */
export async function seedWorkspaceRoles() {
	const workspace = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);

	const ownerUser = await seedUser(`owner-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(workspace.id, ownerUser.id, "owner");
	const ownerToken = await seedToken(workspace.id, ownerUser.id);

	const memberUser = await seedUser(`member-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(workspace.id, memberUser.id, "member");
	const memberToken = await seedToken(workspace.id, memberUser.id);

	const viewerUser = await seedUser(`viewer-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(workspace.id, viewerUser.id, "viewer");
	const viewerToken = await seedToken(workspace.id, viewerUser.id);

	return {
		workspace,
		owner: { user: ownerUser, token: ownerToken },
		member: { user: memberUser, token: memberToken },
		viewer: { user: viewerUser, token: viewerToken },
	};
}
