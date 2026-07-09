import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedGroupGrant, seedIssue, seedProject, seedWorkspaceRoles } from "./helpers";

// PROJ-319: pin the admin-bypass path through the hand-written SQL callers of
// visibleProjectSqlFragment (search) and the effectiveProjectRole/isWorkspaceAdmin
// bypass used by flow-metrics, contrasted against a non-admin member who is
// default-deny until granted.

async function search(token: string, slug: string, q: string) {
	const res = await SELF.fetch(`http://localhost/api/issues/search?q=${encodeURIComponent(q)}`, {
		headers: authHeaders(token, slug),
	});
	return { status: res.status, body: (await res.json()) as Array<{ project_id: string }> };
}

// seedIssue() inserts directly into `issues`, bypassing the FTS index (which is
// populated by the create-issue service, not a DB trigger); go through the REST
// route so search can actually find these issues.
async function createIssue(token: string, slug: string, projectId: string, title: string) {
	const res = await SELF.fetch("http://localhost/api/issues", {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({ projectId, title }),
	});
	expect(res.status).toBe(201);
}

describe("PROJ-319 admin bypass pinning", () => {
	it("owner's search sees issues across projects they hold no group grant on", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const p1 = await seedProject(roles.workspace.id, "P1");
		const p2 = await seedProject(roles.workspace.id, "P2");
		await createIssue(roles.owner.token, slug, p1.id, "sentinel-bypass-token");
		await createIssue(roles.owner.token, slug, p2.id, "sentinel-bypass-token");

		const result = await search(roles.owner.token, slug, "sentinel-bypass-token");
		expect(result.status).toBe(200);
		const projectIds = result.body.map((i) => i.project_id).sort();
		expect(projectIds).toEqual([p1.id, p2.id].sort());
	});

	it("owner's get_flow_metrics returns real data for an ungranted project", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "UNGRANTED");
		await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "Metrics issue",
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${project.id}/flow-metrics`, {
			headers: authHeaders(roles.owner.token, slug),
		});
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as { leadTime: { count: number } };
		expect(metrics.leadTime).toBeDefined();
	});

	it("a non-admin member granted only P1 sees only P1 in search (contrast)", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const p1 = await seedProject(roles.workspace.id, "MP1");
		const p2 = await seedProject(roles.workspace.id, "MP2");
		await createIssue(roles.owner.token, slug, p1.id, "sentinel-scoped-token");
		await createIssue(roles.owner.token, slug, p2.id, "sentinel-scoped-token");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, p1.id, "member");

		const result = await search(roles.member.token, slug, "sentinel-scoped-token");
		expect(result.status).toBe(200);
		expect(result.body.map((i) => i.project_id)).toEqual([p1.id]);
	});

	it("get_flow_metrics 404s for a non-admin member with no grant on the project", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "MUNGRANTED");
		await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "Hidden metrics",
		});

		const res = await SELF.fetch(`http://localhost/api/projects/${project.id}/flow-metrics`, {
			headers: authHeaders(roles.member.token, slug),
		});
		expect(res.status).toBe(404);
	});
});
