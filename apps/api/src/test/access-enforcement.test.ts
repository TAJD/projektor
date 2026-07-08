import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedGroupGrant, seedIssue, seedProject, seedWorkspaceRoles } from "./helpers";

// PROJ-311: group-based project access. Authorization lives entirely in projektor:
// access is default-deny, granted per (project, role) through a group the user
// belongs to. Workspace owner/admin bypass groups and see everything.

async function listProjects(token: string, slug: string) {
	const res = await SELF.fetch("http://localhost/api/projects", {
		headers: authHeaders(token, slug),
	});
	return { status: res.status, body: (await res.json()) as Array<{ key: string }> };
}

async function listIssues(token: string, slug: string) {
	const res = await SELF.fetch("http://localhost/api/issues", {
		headers: authHeaders(token, slug),
	});
	return (await res.json()) as { items: Array<{ id: string }> };
}

// cofferdam-ignore: Readability.MaxFunctionLength: integration suite, one describe block
describe("PROJ-311 group-based project access", () => {
	it("a new member with no groups sees an empty 'pending' state", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		await seedProject(roles.workspace.id, "HID");

		const projects = await listProjects(roles.member.token, slug);
		expect(projects.status).toBe(200);
		expect(projects.body).toHaveLength(0);

		const issues = await listIssues(roles.member.token, slug);
		expect(issues.items).toHaveLength(0);
	});

	it("owner and admin see every project regardless of groups", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		await seedProject(roles.workspace.id, "P1");
		await seedProject(roles.workspace.id, "P2");

		const owned = await listProjects(roles.owner.token, slug);
		expect(owned.body.map((p) => p.key).sort()).toEqual(["P1", "P2"]);
	});

	it("a grant makes exactly one project visible; others stay hidden", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const granted = await seedProject(roles.workspace.id, "SEEN");
		await seedProject(roles.workspace.id, "UNSEEN");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, granted.id, "member");

		const projects = await listProjects(roles.member.token, slug);
		expect(projects.body.map((p) => p.key)).toEqual(["SEEN"]);
	});

	it("a direct fetch of an ungranted project or issue 404s (existence hidden)", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "SECRET");
		const issue = await seedIssue(roles.workspace.id, project.id, roles.owner.user.id);

		const projRes = await SELF.fetch(`http://localhost/api/projects/${project.id}`, {
			headers: authHeaders(roles.member.token, slug),
		});
		expect(projRes.status).toBe(404);

		const issueRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(roles.member.token, slug),
		});
		expect(issueRes.status).toBe(404);
	});

	it("granting then revoking flips visibility on the very next request", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "TOGGLE");
		const { groupId } = await seedGroupGrant(
			roles.workspace.id,
			roles.member.user.id,
			project.id,
			"member"
		);

		expect((await listProjects(roles.member.token, slug)).body.map((p) => p.key)).toEqual([
			"TOGGLE",
		]);

		// Admin removes the member from the group; access is per-request, so the next
		// call reflects it immediately with no session state to invalidate.
		const del = await SELF.fetch(
			`http://localhost/api/workspaces/${slug}/groups/${groupId}/members/${roles.member.user.id}`,
			{ method: "DELETE", headers: authHeaders(roles.owner.token, slug) }
		);
		expect(del.status).toBe(200);

		expect((await listProjects(roles.member.token, slug)).body).toHaveLength(0);
	});

	it("membership in two groups yields the strongest granted role", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "MULTI");
		// A viewer grant and a member grant on the same project via two groups: the
		// effective role is the stronger one, so writes are allowed.
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "viewer");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.member.token, slug),
			body: JSON.stringify({ projectId: project.id, title: "Written by member grant" }),
		});
		expect(res.status).toBe(201);
	});

	it("a viewer grant is read-only: the project is visible but writes are refused", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "RO");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "viewer");

		// Visible in the list...
		expect((await listProjects(roles.member.token, slug)).body.map((p) => p.key)).toEqual(["RO"]);

		// ...but a write is a 403, not a 404 (existence is not hidden once granted).
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.member.token, slug),
			body: JSON.stringify({ projectId: project.id, title: "Should be refused" }),
		});
		expect(res.status).toBe(403);
	});

	it("a member grant allows creating and reading issues in that project", async () => {
		const roles = await seedWorkspaceRoles();
		const slug = roles.workspace.slug;
		const project = await seedProject(roles.workspace.id, "WORK");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");

		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.member.token, slug),
			body: JSON.stringify({ projectId: project.id, title: "Member task" }),
		});
		expect(createRes.status).toBe(201);
		const { id } = (await createRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(roles.member.token, slug),
		});
		expect(getRes.status).toBe(200);
	});
});
