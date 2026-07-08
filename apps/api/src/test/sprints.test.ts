import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedProjectFixture,
	seedWorkspaceRoles,
} from "./helpers";

// PROJ-311: role-guard tests grant the member a member-role and the viewer a
// viewer-role on the project so both can see it — the assertions then verify the
// viewer's writes are still refused (read-only), not merely hidden.

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Sprints API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
	});

	async function createSprint(body: Record<string, unknown>) {
		return SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	it("POST /api/sprints creates a sprint", async () => {
		const res = await createSprint({ projectId, name: "Sprint 1" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBeTruthy();
	});

	it("GET /api/sprints?projectId= returns empty list initially", async () => {
		const res = await SELF.fetch(`http://localhost/api/sprints?projectId=${projectId}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: unknown[] };
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items).toHaveLength(0);
	});

	it("POST then GET lists the sprint", async () => {
		await createSprint({ projectId, name: "Sprint 1", goal: "Ship the feature" });

		const res = await SELF.fetch(`http://localhost/api/sprints?projectId=${projectId}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { items: Array<Record<string, unknown>> };
		expect(body.items).toHaveLength(1);
		expect(body.items[0].name).toBe("Sprint 1");
		expect(body.items[0].goal).toBe("Ship the feature");
		expect(body.items[0].status).toBe("planned");
	});

	it("GET /api/sprints/:id returns the sprint", async () => {
		const createRes = await createSprint({ projectId, name: "Sprint 2" });
		const { id } = (await createRes.json()) as { id: string };

		const res = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const sprint = (await res.json()) as { name: string; status: string };
		expect(sprint.name).toBe("Sprint 2");
		expect(sprint.status).toBe("planned");
	});

	it("GET /api/sprints/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/sprints/${crypto.randomUUID()}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH /api/sprints/:id updates sprint fields", async () => {
		const createRes = await createSprint({ projectId, name: "Draft Sprint" });
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "Sprint 1", status: "active", goal: "Updated goal" }),
		});
		expect(patchRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			headers: authHeaders(token, slug),
		});
		const sprint = (await getRes.json()) as { name: string; status: string; goal: string };
		expect(sprint.name).toBe("Sprint 1");
		expect(sprint.status).toBe("active");
		expect(sprint.goal).toBe("Updated goal");
	});

	it("POST /api/sprints/:id/complete marks active sprint completed", async () => {
		const createRes = await createSprint({ projectId, name: "Active Sprint" });
		const { id } = (await createRes.json()) as { id: string };

		// First make it active
		await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ status: "active" }),
		});

		const completeRes = await SELF.fetch(`http://localhost/api/sprints/${id}/complete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(completeRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			headers: authHeaders(token, slug),
		});
		const sprint = (await getRes.json()) as { status: string };
		expect(sprint.status).toBe("completed");
	});

	it("POST /api/sprints/:id/complete rejects planned sprint", async () => {
		const createRes = await createSprint({ projectId, name: "Planned Sprint" });
		const { id } = (await createRes.json()) as { id: string };

		const completeRes = await SELF.fetch(`http://localhost/api/sprints/${id}/complete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(completeRes.status).toBe(400);
	});

	it("DELETE /api/sprints/:id removes the sprint", async () => {
		const createRes = await createSprint({ projectId, name: "To delete" });
		const { id } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(deleteRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(404);
	});

	it("POST /api/sprints/:id/move-issues bulk moves issues to sprint", async () => {
		const sprintRes = await createSprint({ projectId, name: "Target Sprint" });
		const { id: sprintId } = (await sprintRes.json()) as { id: string };

		const issue1 = await seedIssue(workspaceId, projectId, userId, { title: "Issue A" });
		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Issue B" });

		const moveRes = await SELF.fetch(`http://localhost/api/sprints/${sprintId}/move-issues`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueIds: [issue1.id, issue2.id] }),
		});
		expect(moveRes.status).toBe(200);
		const result = (await moveRes.json()) as { ok: boolean; count: number };
		expect(result.ok).toBe(true);
		expect(result.count).toBe(2);

		// Verify issues now appear in sprint filter
		const listRes = await SELF.fetch(`http://localhost/api/issues?sprintId=${sprintId}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await listRes.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(2);
		const titles = page.items.map((i) => i.title).sort();
		expect(titles).toEqual(["Issue A", "Issue B"]);
	});

	it("DELETE sprint clears sprint_id on issues (ON DELETE SET NULL)", async () => {
		const sprintRes = await createSprint({ projectId, name: "Sprint to delete" });
		const { id: sprintId } = (await sprintRes.json()) as { id: string };

		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Sprint issue" });

		await SELF.fetch(`http://localhost/api/sprints/${sprintId}/move-issues`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueIds: [issue.id] }),
		});

		await SELF.fetch(`http://localhost/api/sprints/${sprintId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});

		// Issue should still exist but sprint_id should be null
		const issueRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(issueRes.status).toBe(200);
		const issueData = (await issueRes.json()) as { sprint_id: string | null };
		expect(issueData.sprint_id).toBeNull();
	});

	it("POST /api/sprints/:id/move-issues returns 404 for unknown sprint", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Orphan issue" });

		const res = await SELF.fetch(
			`http://localhost/api/sprints/${crypto.randomUUID()}/move-issues`,
			{
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ issueIds: [issue.id] }),
			}
		);
		expect(res.status).toBe(404);
	});

	it("lists multiple sprints ordered by created_at", async () => {
		await createSprint({ projectId, name: "First Sprint" });
		await createSprint({ projectId, name: "Second Sprint" });
		await createSprint({ projectId, name: "Third Sprint" });

		const res = await SELF.fetch(`http://localhost/api/sprints?projectId=${projectId}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { items: Array<{ name: string }> };
		expect(body.items).toHaveLength(3);
		expect(body.items[0].name).toBe("First Sprint");
		expect(body.items[2].name).toBe("Third Sprint");
	});

	it("sprints are scoped to workspace — cross-workspace sprint not visible", async () => {
		const other = await seedFixture();
		const otherProject = await seedProject(other.workspace.id, "OTH");

		// Create sprint in other workspace
		await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ projectId: otherProject.id, name: "Other Workspace Sprint" }),
		});

		// Our workspace sees none
		const res = await SELF.fetch(`http://localhost/api/sprints?projectId=${projectId}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { items: unknown[] };
		expect(body.items).toHaveLength(0);
	});
});

describe("Sprints role guards", () => {
	it("viewer cannot create a sprint (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

		const res = await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, name: "Viewer Sprint" }),
		});
		expect(res.status).toBe(403);
	});

	it("viewer cannot update a sprint (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

		const createRes = await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, name: "Member Sprint" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "PATCH",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ name: "Hacked" }),
		});
		expect(patchRes.status).toBe(403);
	});

	it("viewer cannot delete a sprint (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

		const createRes = await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, name: "Member Sprint" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "DELETE",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(403);
	});

	it("viewer cannot complete a sprint (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

		const createRes = await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, name: "Sprint" }),
		});
		const { id } = (await createRes.json()) as { id: string };
		await SELF.fetch(`http://localhost/api/sprints/${id}`, {
			method: "PATCH",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ status: "active" }),
		});

		const completeRes = await SELF.fetch(`http://localhost/api/sprints/${id}/complete`, {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
		});
		expect(completeRes.status).toBe(403);
	});

	it("viewer cannot move issues to a sprint (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, project.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

		const createRes = await SELF.fetch("http://localhost/api/sprints", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, name: "Sprint" }),
		});
		const { id: sprintId } = (await createRes.json()) as { id: string };

		const issue = await seedIssue(roles.workspace.id, project.id, roles.member.user.id);

		const moveRes = await SELF.fetch(`http://localhost/api/sprints/${sprintId}/move-issues`, {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ issueIds: [issue.id] }),
		});
		expect(moveRes.status).toBe(403);
	});
});
