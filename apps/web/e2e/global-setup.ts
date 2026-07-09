/**
 * Playwright global setup — runs once before all test workers.
 *
 * Creates an isolated test workspace on the target dev deployment so tests
 * never read from or write to the production/default workspace.
 *
 * Authentication relies on the server-side dev bypass: when the deployment is
 * configured with ENVIRONMENT=development and DEV_USER_EMAIL, every API
 * request is automatically authenticated as that user — no credentials needed
 * in setup.  This is intentional: the suite is designed for dev deployments
 * only (see README.md).
 *
 * Writes a JSON context file (`e2e/.e2e-ctx.json`) consumed by board.spec.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface E2EContext {
	workspaceSlug: string;
	todoStatusId: string;
	inProgressStatusId: string;
	testIssueId: string;
	grantedProjectId: string;
	grantedProjectKey: string;
	ungrantedProjectId: string;
	ungrantedProjectKey: string;
	groupId: string;
	groupName: string;
	memberEmail: string;
	memberUserId: string;
}

// Resolved at runtime relative to the playwright config file's cwd (apps/web/).
export const CTX_FILE = path.resolve(process.cwd(), "e2e", ".e2e-ctx.json");

async function post(url: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`POST ${url} → ${res.status}: ${text}`);
	}
	return res.json();
}

async function wsPost(url: string, slug: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Workspace-Slug": slug,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`POST ${url} (ws=${slug}) → ${res.status}: ${text}`);
	}
	return res.json();
}

async function wsPut(url: string, slug: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"X-Workspace-Slug": slug,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PUT ${url} (ws=${slug}) → ${res.status}: ${text}`);
	}
	return res.json();
}

async function wsGet(url: string, slug: string): Promise<unknown> {
	const res = await fetch(url, { headers: { "X-Workspace-Slug": slug } });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GET ${url} (ws=${slug}) → ${res.status}: ${text}`);
	}
	return res.json();
}

// cofferdam-ignore: Design.OrphanExport: Playwright globalSetup convention, referenced by file path
export default async function globalSetup(): Promise<void> {
	const base = process.env.E2E_BASE_URL;
	if (!base) {
		throw new Error(
			"E2E_BASE_URL is required.\n" +
				"Point it at a dev deployment (ENVIRONMENT=development, DEV_USER_EMAIL set).\n" +
				"Example: E2E_BASE_URL=https://dev.your-instance.workers.dev pnpm --filter @projektor/web exec playwright test"
		);
	}

	// Use a timestamp slug so each CI run gets its own isolated workspace.
	const slug = `e2e-${Date.now()}`;
	// cofferdam-ignore: Warning.NoConsoleLog: CI-visible e2e setup progress, not a debug leftover
	console.log(`[e2e setup] Creating isolated workspace: ${slug}`);

	// 1. Create workspace (auth: dev bypass on the server)
	await post(`${base}/api/workspaces`, { name: "E2E Test Workspace", slug });

	// 2. Workspace creation auto-seeds default task statuses (including "todo"
	// and "in_progress"), so read them back rather than re-creating them.
	const seededStatuses = (await wsGet(`${base}/api/task-statuses`, slug)) as Array<{
		id: string;
		key: string;
	}>;
	const todoStatus = seededStatuses.find((s) => s.key === "todo");
	const inProgressStatus = seededStatuses.find((s) => s.key === "in_progress");
	if (!todoStatus || !inProgressStatus) {
		throw new Error(
			`Expected default 'todo' and 'in_progress' task statuses to be seeded for workspace ${slug}, got keys: ${seededStatuses.map((s) => s.key).join(", ")}`
		);
	}

	// 3. Create a project (issues require a projectId)
	const project = (await wsPost(`${base}/api/projects`, slug, {
		name: "E2E Project",
		key: "E2E",
	})) as { id: string; key: string };

	// 4. Create the issue we'll drag in the desktop test
	const dragIssue = (await wsPost(`${base}/api/issues`, slug, {
		projectId: project.id,
		title: "E2E drag test issue",
		statusId: todoStatus.id,
		priority: "medium",
	})) as { id: string };

	// 5. Create a second issue so the board has meaningful content
	await wsPost(`${base}/api/issues`, slug, {
		projectId: project.id,
		title: "E2E background issue",
		statusId: todoStatus.id,
		priority: "low",
	});

	// 6. PROJ-313: group-access fixture — a second (ungranted) project, a member
	// invited into the workspace, and a group that grants the member access to
	// the first project only.
	// cofferdam-ignore: Warning.NoConsoleLog: CI-visible e2e setup progress, not a debug leftover
	console.log("[e2e setup] Provisioning group-access fixture");

	const ungrantedProject = (await wsPost(`${base}/api/projects`, slug, {
		name: "E2E Ungranted",
		key: "E2EU",
	})) as { id: string; key: string };

	const memberEmail = process.env.E2E_MEMBER_EMAIL ?? `e2e-member-${slug}@example.com`;
	await wsPost(`${base}/api/workspaces/${slug}/members`, slug, {
		email: memberEmail,
		role: "member",
	});
	const workspaceDetail = (await wsGet(`${base}/api/workspaces/${slug}`, slug)) as {
		members: Array<{ id: string; email: string }>;
	};
	const memberRecord = workspaceDetail.members.find((m) => m.email === memberEmail);
	if (!memberRecord) {
		throw new Error(`Expected invited member ${memberEmail} in workspace members list`);
	}

	const group = (await wsPost(`${base}/api/workspaces/${slug}/groups`, slug, {
		name: "E2E Access Group",
	})) as { id: string; name: string };

	await wsPut(`${base}/api/workspaces/${slug}/groups/${group.id}/grants`, slug, {
		projectId: project.id,
		role: "member",
	});
	await wsPost(`${base}/api/workspaces/${slug}/groups/${group.id}/members`, slug, {
		userId: memberRecord.id,
	});

	const ctx: E2EContext = {
		workspaceSlug: slug,
		todoStatusId: todoStatus.id,
		inProgressStatusId: inProgressStatus.id,
		testIssueId: dragIssue.id,
		grantedProjectId: project.id,
		grantedProjectKey: project.key,
		ungrantedProjectId: ungrantedProject.id,
		ungrantedProjectKey: ungrantedProject.key,
		groupId: group.id,
		groupName: group.name,
		memberEmail,
		memberUserId: memberRecord.id,
	};

	fs.writeFileSync(CTX_FILE, JSON.stringify(ctx, null, 2));
	// cofferdam-ignore: Warning.NoConsoleLog: CI-visible e2e setup progress, not a debug leftover
	console.log(`[e2e setup] Context written to ${CTX_FILE}`);
}
