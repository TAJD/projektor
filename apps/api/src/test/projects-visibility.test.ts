// PROJ-581: project visibility is default-deny (PROJ-311) for every non-admin member,
// including a bare `viewer` and the anonymous PUBLIC_READ_ONLY viewer — the
// cross-workspace list (GET /api/projects) and the single-workspace list (list_projects)
// agree. The public viewer is placed in a "Public viewers" group, so publishing a
// project to anonymous visitors is one explicit grant to that group.

import { env } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { describe, expect, it } from "vitest";
import { updateIssue } from "../services/issues";
import { listProjects, listProjectsAcrossWorkspaces } from "../services/projects";
import { PUBLIC_VIEWERS_GROUP_NAME, provisionPublicViewer } from "../services/provisioning";
import type { ServiceCtx } from "../services/types";
import {
	seedGroupGrant,
	seedIssue,
	seedMember,
	seedProject,
	seedUser,
	seedWorkspace,
} from "./helpers";

function viewerCtx(workspaceId: string, userId: string): ServiceCtx {
	return { db: env.DB, kv: env.KV, r2: env.R2, workspaceId, userId, role: "viewer" };
}

async function ids(p: Promise<unknown>): Promise<string[]> {
	return ((await p) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe("PROJ-581: viewers see projects only through grants, consistently on both lists", () => {
	it("a bare viewer sees no projects in either list; a granted one sees exactly the granted project", async () => {
		const ws = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);
		const viewer = await seedUser(`v-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(ws.id, viewer.id, "viewer");
		const a = await seedProject(ws.id, "AAA");
		await seedProject(ws.id, "BBB");
		const ctx = viewerCtx(ws.id, viewer.id);

		expect(await ids(listProjects(ctx))).toEqual([]);
		expect(await ids(listProjectsAcrossWorkspaces(viewer.id, env.DB))).toEqual([]);

		await seedGroupGrant(ws.id, viewer.id, a.id, "viewer");
		expect(await ids(listProjects(ctx))).toEqual([a.id]);
		expect(await ids(listProjectsAcrossWorkspaces(viewer.id, env.DB))).toEqual([a.id]);
	});

	it("the public viewer is put in the 'Public viewers' group; granting that group publishes a project", async () => {
		const slug = `pub-${crypto.randomUUID().slice(0, 8)}`;
		const ws = await seedWorkspace(slug);
		const pub = await seedUser(`public-${crypto.randomUUID().slice(0, 8)}@projektor.local`);
		const published = await seedProject(ws.id, "PUB");
		await seedProject(ws.id, "PRV");
		await provisionPublicViewer({ ...env, DEFAULT_WORKSPACE_SLUG: slug } as Env, pub);

		const group = await env.DB.prepare(
			"SELECT g.id FROM user_groups g JOIN user_group_members m ON m.group_id = g.id WHERE g.workspace_id = ? AND g.name = ? AND m.user_id = ?"
		)
			.bind(ws.id, PUBLIC_VIEWERS_GROUP_NAME, pub.id)
			.first<{ id: string }>();
		expect(group).not.toBeNull();

		expect(await ids(listProjectsAcrossWorkspaces(pub.id, env.DB))).toEqual([]);
		await env.DB.prepare(
			"INSERT INTO group_project_grants (group_id, project_id, role) VALUES (?, ?, 'viewer')"
		)
			.bind(group?.id, published.id)
			.run();
		expect(await ids(listProjectsAcrossWorkspaces(pub.id, env.DB))).toEqual([published.id]);
		expect(await ids(listProjects(viewerCtx(ws.id, pub.id)))).toEqual([published.id]);
	});

	it("the public viewer can't write even when its group is granted `member`", async () => {
		const ws = await seedWorkspace(`pw-${crypto.randomUUID().slice(0, 8)}`);
		const owner = await seedUser(`o-${crypto.randomUUID().slice(0, 8)}@example.com`);
		const pub = await seedUser(`public-${crypto.randomUUID().slice(0, 8)}@projektor.local`);
		await seedMember(ws.id, pub.id, "viewer");
		const project = await seedProject(ws.id, "PWR");
		await seedGroupGrant(ws.id, pub.id, project.id, "member");
		const issue = await seedIssue(ws.id, project.id, owner.id, { title: "Keep me" });
		const ctx: ServiceCtx = {
			...viewerCtx(ws.id, pub.id),
			auth: { kind: "human", method: "public" },
		};
		await expect(updateIssue(ctx, issue.id, { title: "defaced" })).rejects.toThrow(
			/Insufficient permissions/
		);
		// A signed-in viewer with a member grant can still write (PROJ-311's documented model).
		await expect(
			updateIssue(
				{ ...viewerCtx(ws.id, pub.id), auth: { kind: "human", method: "access" } },
				issue.id,
				{
					title: "edited by a granted viewer",
				}
			)
		).resolves.toBeTruthy();
	});

	it("adopts an existing 'Public viewers' group and stays idempotent across runs", async () => {
		const slug = `pa-${crypto.randomUUID().slice(0, 8)}`;
		const ws = await seedWorkspace(slug);
		const pub = await seedUser(`public-${crypto.randomUUID().slice(0, 8)}@projektor.local`);
		const existing = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO user_groups (id, workspace_id, name, created_at) VALUES (?, ?, ?, 0)"
		)
			.bind(existing, ws.id, PUBLIC_VIEWERS_GROUP_NAME)
			.run();
		const e = { ...env, DEFAULT_WORKSPACE_SLUG: slug } as Env;
		await provisionPublicViewer(e, pub);
		await env.KV.delete(`provisioned:${pub.id}:public-v2`); // force a second real run
		await provisionPublicViewer(e, pub);
		const rows = await env.DB.prepare(
			"SELECT g.id FROM user_groups g JOIN user_group_members m ON m.group_id = g.id WHERE g.workspace_id = ? AND m.user_id = ?"
		)
			.bind(ws.id, pub.id)
			.all<{ id: string }>();
		expect(rows.results.map((r) => r.id)).toEqual([existing]);
	});
});
