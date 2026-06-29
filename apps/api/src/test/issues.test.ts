import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedIssue,
	seedMember,
	seedProject,
	seedTaskStatus,
	seedTaskType,
	seedUser,
	seedWorkspaceRoles,
} from "./helpers";

describe("Issues API", () => {
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

	type IssuesPage = { items: Array<Record<string, unknown>>; nextCursor: number | null };

	async function listIssues(url = "http://localhost/api/issues") {
		const res = await SELF.fetch(url, { headers: authHeaders(token, slug) });
		return { res, page: (await res.json()) as IssuesPage };
	}

	it("GET /api/issues returns empty list initially", async () => {
		const { res, page } = await listIssues();
		expect(res.status).toBe(200);
		expect(Array.isArray(page.items)).toBe(true);
		expect(page.items).toHaveLength(0);
		expect(page.nextCursor).toBeNull();
	});

	it("POST /api/issues creates an issue", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "First issue", priority: "high" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBeTruthy();
	});

	it("POST then GET returns the created issue", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Visible issue" }),
		});

		const { page } = await listIssues();
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Visible issue");
	});

	it("auto-increments issue number per project", async () => {
		for (const title of ["Issue A", "Issue B", "Issue C"]) {
			await SELF.fetch("http://localhost/api/issues", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ projectId, title }),
			});
		}
		const { page } = await listIssues();
		const numbers = (page.items as Array<{ number: number }>)
			.map((i) => i.number)
			.sort((a, b) => a - b);
		expect(numbers).toEqual([1, 2, 3]);
	});

	it("concurrent creates in the same project receive distinct issue numbers", async () => {
		const [res1, res2] = await Promise.all([
			SELF.fetch("http://localhost/api/issues", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ projectId, title: "Concurrent A" }),
			}),
			SELF.fetch("http://localhost/api/issues", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ projectId, title: "Concurrent B" }),
			}),
		]);
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const { number: n1 } = (await res1.json()) as { number: number };
		const { number: n2 } = (await res2.json()) as { number: number };
		expect(n1).not.toBe(n2);
	});

	it("PATCH /api/issues/:id updates status", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "To update" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ status: "in_progress" }),
		});
		expect(patchRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { status: string };
		expect(issue.status).toBe("in_progress");
	});

	it("DELETE /api/issues/:id removes the issue", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "To delete" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(404);
	});

	it("filters issues by status", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Backlog item" }),
		});
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "In progress item" }),
		});
		const { id } = (await createRes.json()) as { id: string };
		await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ status: "in_progress" }),
		});

		const { page } = await listIssues("http://localhost/api/issues?status=in_progress");
		expect(page.items).toHaveLength(1);
		expect((page.items[0] as { title: string }).title).toBe("In progress item");
	});

	it("rejects requests from non-members", async () => {
		const other = await seedFixture();
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(other.token, slug),
		});
		expect(res.status).toBe(403);
	});

	it("POST with assigneeId and labels persists them", async () => {
		const assignee = await seedUser("assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Assigned",
				assigneeId: assignee.id,
				labels: ["bug", "urgent"],
			}),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { assignee_id: string; labels: string };
		expect(issue.assignee_id).toBe(assignee.id);
		expect(JSON.parse(issue.labels)).toEqual(["bug", "urgent"]);
	});

	it("PATCH with assigneeId (camelCase) updates the assignee", async () => {
		const assignee = await seedUser("patch-assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Unassigned" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ assigneeId: assignee.id }),
		});
		expect(patchRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { assignee_id: string };
		expect(issue.assignee_id).toBe(assignee.id);
	});

	it("PATCH with labels updates labels", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Label test", labels: ["old"] }),
		});
		const { id } = (await createRes.json()) as { id: string };

		await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ labels: ["new", "tag"] }),
		});

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { labels: string };
		expect(JSON.parse(issue.labels)).toEqual(["new", "tag"]);
	});

	it("filters issues by assignee", async () => {
		const assignee = await seedUser("filter-assignee@example.com");
		await seedMember(workspaceId, assignee.id);

		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Unassigned issue" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Assigned issue", assigneeId: assignee.id }),
		});

		const { page } = await listIssues(`http://localhost/api/issues?assignee=${assignee.id}`);
		expect(page.items).toHaveLength(1);
		expect((page.items[0] as { title: string }).title).toBe("Assigned issue");
	});

	it("cursor pagination returns next page", async () => {
		// Seed with explicit distinct timestamps so cursor (created_at <) math works correctly
		const base = 1_700_000_000;
		await seedIssue(workspaceId, projectId, userId, { title: "Issue 1", createdAt: base + 100 });
		await seedIssue(workspaceId, projectId, userId, { title: "Issue 2", createdAt: base + 200 });
		await seedIssue(workspaceId, projectId, userId, { title: "Issue 3", createdAt: base + 300 });

		const { page: first } = await listIssues("http://localhost/api/issues?limit=2");
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();

		const { page: second } = await listIssues(
			`http://localhost/api/issues?limit=2&cursor=${first.nextCursor}`
		);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
	});

	it("projectId filter scopes results to that project only", async () => {
		const otherProject = await seedProject(workspaceId, "OTH");
		await seedIssue(workspaceId, projectId, userId, { title: "Project A issue" });
		await seedIssue(workspaceId, otherProject.id, userId, { title: "Project B issue" });

		const { page } = await listIssues(`http://localhost/api/issues?project=${projectId}`);
		expect(page.items).toHaveLength(1);
		expect((page.items[0] as { title: string }).title).toBe("Project A issue");
	});

	it("projectId filter returns all project issues up to limit, not just newest workspace-wide", async () => {
		// Seed a second project with many newer issues so workspace-wide listing would return them first
		const newerProject = await seedProject(workspaceId, "NEW");
		const base = Math.floor(Date.now() / 1000);
		for (let i = 0; i < 55; i++) {
			await seedIssue(workspaceId, newerProject.id, userId, {
				title: `Newer issue ${i}`,
				createdAt: base + i + 1,
			});
		}
		// Seed issues in projectId with older timestamps — would be cut off by workspace-wide limit=50
		for (let i = 0; i < 10; i++) {
			await seedIssue(workspaceId, projectId, userId, {
				title: `Older issue ${i}`,
				createdAt: base - 1000 + i,
			});
		}

		// Without projectId: only newest 50 come back — all from newerProject
		const { page: all } = await listIssues("http://localhost/api/issues?limit=50");
		const allTitles = all.items.map((i) => (i as { title: string }).title);
		expect(allTitles.some((t) => t.startsWith("Older issue"))).toBe(false);

		// With projectId: all 10 project-scoped issues come back regardless of workspace age
		const { page: scoped } = await listIssues(
			`http://localhost/api/issues?project=${projectId}&limit=100`
		);
		expect(scoped.items).toHaveLength(10);
		expect(
			scoped.items.every((i) => (i as { title: string }).title.startsWith("Older issue"))
		).toBe(true);
	});

	it("GET /api/issues/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${crypto.randomUUID()}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/issues/KEY-NUMBER looks up by ref", async () => {
		// beforeEach seeds a project with key='PROJ'; first issue in it is PROJ-1
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Ref issue" }),
		});
		expect(createRes.status).toBe(201);

		const getRes = await SELF.fetch("http://localhost/api/issues/PROJ-1", {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
		const issue = (await getRes.json()) as { title: string };
		expect(issue.title).toBe("Ref issue");
	});

	it("GET /api/issues/search finds issues by title keyword", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Authentication bug",
				body: "Login fails on Safari",
			}),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Performance regression",
				body: "Slow query on dashboard",
			}),
		});

		const res = await SELF.fetch("http://localhost/api/issues/search?q=Authentication", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Authentication bug");
	});

	it("GET /api/issues/search finds issues by body keyword", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Some issue", body: "Contains wrangler reference" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Other issue", body: "Unrelated content" }),
		});

		const res = await SELF.fetch("http://localhost/api/issues/search?q=wrangler", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Some issue");
	});

	it("GET /api/issues/search respects workspace scoping", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Workspace A issue", body: "unique-sentinel" }),
		});

		const other = await seedFixture();
		const otherProject = await seedProject(other.workspace.id, "OTH");
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({
				projectId: otherProject.id,
				title: "Workspace B issue",
				body: "unique-sentinel",
			}),
		});

		const res = await SELF.fetch("http://localhost/api/issues/search?q=unique-sentinel", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Workspace A issue");
	});

	it("GET /api/issues/search with projectId filters to that project", async () => {
		const otherProject = await seedProject(workspaceId, "SEC");
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Alpha project issue", body: "shared-term" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId: otherProject.id,
				title: "Beta project issue",
				body: "shared-term",
			}),
		});

		const res = await SELF.fetch(
			`http://localhost/api/issues/search?q=shared-term&projectId=${projectId}`,
			{
				headers: authHeaders(token, slug),
			}
		);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Alpha project issue");
	});

	it("GET /api/issues/search returns project fields in results", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Field check issue" }),
		});

		const res = await SELF.fetch("http://localhost/api/issues/search?q=Field+check", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{
			id: string;
			number: number;
			title: string;
			status: string;
			priority: string;
			project_key: string;
		}>;
		expect(results).toHaveLength(1);
		expect(results[0].project_key).toBe("PROJ");
		expect(results[0].status).toBeDefined();
		expect(results[0].priority).toBeDefined();
		expect(results[0].number).toBeDefined();
	});

	it("GET /api/issues/search returns 400 when query is missing", async () => {
		const res = await SELF.fetch("http://localhost/api/issues/search", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/issues/search ranks by bm25 (title+body match scores higher than body-only)", async () => {
		// Issue with the term in both title AND body — higher bm25 score
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Authentication bug",
				body: "authentication flow is broken",
			}),
		});
		// Issue with the term only in body — lower bm25 score
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				projectId,
				title: "Performance regression",
				body: "unrelated to authentication",
			}),
		});

		const res = await SELF.fetch("http://localhost/api/issues/search?q=authentication", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(2);
		expect(results[0].title).toBe("Authentication bug");
	});

	it("GET /api/issues/search FTS workspace isolation prevents cross-tenant results", async () => {
		// Seed an issue in the primary workspace
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Primary workspace fts-sentinel", body: "" }),
		});

		// Seed the same term in a completely separate workspace
		const other = await seedFixture();
		const otherProject = await seedProject(other.workspace.id, "OTH");
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({
				projectId: otherProject.id,
				title: "Other workspace fts-sentinel",
				body: "",
			}),
		});

		// Search from the primary workspace must not see the other workspace's issue
		const res = await SELF.fetch("http://localhost/api/issues/search?q=fts-sentinel", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Primary workspace fts-sentinel");
	});

	it("GET /api/issues/search returns empty results for whitespace-only query", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Noise issue" }),
		});
		const res = await SELF.fetch("http://localhost/api/issues/search?q=+++", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as unknown[];
		expect(results).toHaveLength(0);
	});

	it("GET /api/issues/search returns empty results for punctuation-only query", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Noise issue" }),
		});
		const res = await SELF.fetch("http://localhost/api/issues/search?q=!!!", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as unknown[];
		expect(results).toHaveLength(0);
	});

	// ---- Hierarchy (parent_id) tests ----

	it("POST creates a child issue with parentId", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent issue" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };

		const childRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Child issue", parentId }),
		});
		expect(childRes.status).toBe(201);
		const { id: childId } = (await childRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${childId}`, {
			headers: authHeaders(token, slug),
		});
		const child = (await getRes.json()) as { parent_id: string };
		expect(child.parent_id).toBe(parentId);
	});

	it("GET issue includes rollup of child status counts", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent for rollup" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };

		// Create 3 children: 2 backlog, 1 done
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "backlog" });
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "backlog" });
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "done" });

		const getRes = await SELF.fetch(`http://localhost/api/issues/${parentId}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as {
			rollup: { total: number; byStatus: Record<string, number> };
		};
		expect(issue.rollup.total).toBe(3);
		expect(issue.rollup.byStatus.backlog).toBe(2);
		expect(issue.rollup.byStatus.done).toBe(1);
	});

	it("GET issue with no children returns empty rollup", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Childless issue" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as {
			rollup: { total: number; byStatus: Record<string, number> };
		};
		expect(issue.rollup.total).toBe(0);
		expect(issue.rollup.byStatus).toEqual({});
	});

	it("PATCH sets parentId on an existing issue", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };

		const childRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Child (no parent yet)" }),
		});
		const { id: childId } = (await childRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/issues/${childId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ parentId }),
		});
		expect(patchRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${childId}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { parent_id: string };
		expect(issue.parent_id).toBe(parentId);
	});

	it("PATCH clears parentId by setting it to null", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent to detach from" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };

		const childRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Child", parentId }),
		});
		const { id: childId } = (await childRes.json()) as { id: string };

		await SELF.fetch(`http://localhost/api/issues/${childId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ parentId: null }),
		});

		const getRes = await SELF.fetch(`http://localhost/api/issues/${childId}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { parent_id: string | null };
		expect(issue.parent_id).toBeNull();
	});

	it("POST rejects self as parent", async () => {
		// Create issue first, then try to set itself as parent via PATCH
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Self-ref" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ parentId: id }),
		});
		expect(patchRes.status).toBe(400);
	});

	it("PATCH rejects a parentId that would create a cycle", async () => {
		// A → B → C; try to set A.parentId = C (cycle: A is ancestor of C)
		const a = await seedIssue(workspaceId, projectId, userId, { title: "A" });
		const b = await seedIssue(workspaceId, projectId, userId, { title: "B", parentId: a.id });
		const c = await seedIssue(workspaceId, projectId, userId, { title: "C", parentId: b.id });

		const res = await SELF.fetch(`http://localhost/api/issues/${a.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ parentId: c.id }),
		});
		expect(res.status).toBe(400);
	});

	it("POST rejects parent that would exceed depth cap of 5", async () => {
		// Build a chain root → L1 → L2 → L3 → L4 → L5 (L5 is at depth 5)
		const root = await seedIssue(workspaceId, projectId, userId, { title: "Root" });
		const l1 = await seedIssue(workspaceId, projectId, userId, { title: "L1", parentId: root.id });
		const l2 = await seedIssue(workspaceId, projectId, userId, { title: "L2", parentId: l1.id });
		const l3 = await seedIssue(workspaceId, projectId, userId, { title: "L3", parentId: l2.id });
		const l4 = await seedIssue(workspaceId, projectId, userId, { title: "L4", parentId: l3.id });
		const l5 = await seedIssue(workspaceId, projectId, userId, { title: "L5", parentId: l4.id });

		// L5 is at depth 5; adding a child would be depth 6 — must be rejected
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "L6 (should fail)", parentId: l5.id }),
		});
		expect(res.status).toBe(400);
	});

	it("POST accepts parent at depth 4 (child at depth 5 is allowed)", async () => {
		const root = await seedIssue(workspaceId, projectId, userId, { title: "Root" });
		const l1 = await seedIssue(workspaceId, projectId, userId, { title: "L1", parentId: root.id });
		const l2 = await seedIssue(workspaceId, projectId, userId, { title: "L2", parentId: l1.id });
		const l3 = await seedIssue(workspaceId, projectId, userId, { title: "L3", parentId: l2.id });
		const l4 = await seedIssue(workspaceId, projectId, userId, { title: "L4", parentId: l3.id });

		// L4 is at depth 4; adding a child would be depth 5 — must be allowed
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "L5 (should succeed)", parentId: l4.id }),
		});
		expect(res.status).toBe(201);
	});

	it("GET /api/issues?parentId= filters to direct children", async () => {
		const parent = await seedIssue(workspaceId, projectId, userId, { title: "Parent" });
		await seedIssue(workspaceId, projectId, userId, { title: "Child 1", parentId: parent.id });
		await seedIssue(workspaceId, projectId, userId, { title: "Child 2", parentId: parent.id });
		await seedIssue(workspaceId, projectId, userId, { title: "Top-level issue" });

		const { page } = await listIssues(`http://localhost/api/issues?parentId=${parent.id}`);
		expect(page.items).toHaveLength(2);
		const titles = (page.items as Array<{ title: string }>).map((i) => i.title);
		expect(titles).toContain("Child 1");
		expect(titles).toContain("Child 2");
	});

	it("POST rejects parentId from a different workspace", async () => {
		const other = await seedFixture();
		const otherProject = await seedProject(other.workspace.id, "OTH");
		const otherIssue = await seedIssue(other.workspace.id, otherProject.id, other.user.id, {
			title: "Other ws issue",
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Cross-ws child", parentId: otherIssue.id }),
		});
		expect(res.status).toBe(404);
	});
	it("filters by multiple statusIds (OR)", async () => {
		const s1 = await seedTaskStatus(workspaceId, { key: "todo", name: "Todo", category: "todo" });
		const s2 = await seedTaskStatus(workspaceId, { key: "done", name: "Done", category: "done" });
		const s3 = await seedTaskStatus(workspaceId, {
			key: "in_progress",
			name: "In Progress",
			category: "in_progress",
		});

		await seedIssue(workspaceId, projectId, userId, {
			title: "Todo item",
			statusId: s1.id,
		});
		await seedIssue(workspaceId, projectId, userId, {
			title: "Done item",
			statusId: s2.id,
		});
		await seedIssue(workspaceId, projectId, userId, {
			title: "In progress item",
			statusId: s3.id,
		});

		const { page } = await listIssues(`http://localhost/api/issues?statusIds=${s1.id},${s2.id}`);
		expect(page.items).toHaveLength(2);
		const titles = (page.items as Array<{ title: string }>).map((i) => i.title).sort();
		expect(titles).toEqual(["Done item", "Todo item"]);
	});

	it("filters by multiple priorities (OR)", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Urgent issue", priority: "urgent" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "High issue", priority: "high" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Low issue", priority: "low" }),
		});

		const { page } = await listIssues("http://localhost/api/issues?priorities=urgent,high");
		expect(page.items).toHaveLength(2);
		const titles = (page.items as Array<{ title: string }>).map((i) => i.title).sort();
		expect(titles).toEqual(["High issue", "Urgent issue"]);
	});

	it("filters by projectId", async () => {
		const project2 = await seedProject(workspaceId);

		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Project 1 issue" }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId: project2.id, title: "Project 2 issue" }),
		});

		const { page } = await listIssues(`http://localhost/api/issues?project=${project2.id}`);
		expect(page.items).toHaveLength(1);
		expect((page.items[0] as { title: string }).title).toBe("Project 2 issue");
	});

	it("noParent=true returns only issues without a parent", async () => {
		const r1 = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent issue" }),
		});
		const { id: parentId } = (await r1.json()) as { id: string };

		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Child issue", parentId }),
		});

		const { page } = await listIssues("http://localhost/api/issues?noParent=true");
		expect(page.items).toHaveLength(1);
		expect((page.items[0] as { title: string }).title).toBe("Parent issue");
	});

	it("excludeTypeIds drops issues of those types but keeps untyped ones (PROJ-202)", async () => {
		const epic = await seedTaskType(workspaceId, { key: "epic", name: "Epic" });
		await seedIssue(workspaceId, projectId, userId, { title: "An epic", typeId: epic.id });
		await seedIssue(workspaceId, projectId, userId, { title: "A plain issue" });

		const { page } = await listIssues(`http://localhost/api/issues?excludeTypeIds=${epic.id}`);
		const titles = (page.items as Array<{ title: string }>).map((i) => i.title).sort();
		// The epic is excluded; the untyped (NULL type_id) issue must NOT be dropped.
		expect(titles).toEqual(["A plain issue"]);
	});
});

describe("Issues MCP — typeId", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
	});

	async function mcpCall(params: unknown) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
		});
		return res.json() as Promise<{
			result?: { content: Array<{ text: string }> };
			error?: { message: string };
		}>;
	}

	it("MCP create_issue with typeId persists the type", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "epic", name: "Epic" });

		const createResp = await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Epic issue", typeId },
		});
		expect(createResp.error).toBeUndefined();
		const { id } = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_id: string; type_key: string };
		expect(issue.type_id).toBe(typeId);
		expect(issue.type_key).toBe("epic");
	});

	// Regression for PROJ-69: seeded default task types use 32-char hex hash IDs
	// (not dashed UUIDs). The typeId schema must accept them, or the seeded Epic
	// type can never be assigned to an issue.
	it("MCP create_issue accepts a seeded-style 32-hex (non-UUID) typeId", async () => {
		const hashId = "ea3df70345804c3d26ebf139816cae8f";
		const { id: typeId } = await seedTaskType(workspaceId, {
			id: hashId,
			key: "epic",
			name: "Epic",
		});
		expect(typeId).toBe(hashId);

		const createResp = await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Epic via hash id", typeId },
		});
		expect(createResp.error).toBeUndefined();
		const { id } = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_id: string };
		expect(issue.type_id).toBe(hashId);
	});

	it("MCP update_issue sets typeId on an existing issue", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "story", name: "Story" });

		const createResp = await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "No type yet" },
		});
		const { id } = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const updateResp = await mcpCall({ name: "update_issue", arguments: { id, typeId } });
		expect(updateResp.error).toBeUndefined();

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_id: string };
		expect(issue.type_id).toBe(typeId);
	});

	it("MCP update_issue clears typeId with null", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });

		const createResp = await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Typed issue", typeId },
		});
		const { id } = JSON.parse(createResp.result!.content[0].text) as { id: string };

		await mcpCall({ name: "update_issue", arguments: { id, typeId: null } });

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_id: string | null };
		expect(issue.type_id).toBeNull();
	});

	it("MCP list_issues typeId filter returns only matching issues", async () => {
		const { id: bugTypeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
		const { id: storyTypeId } = await seedTaskType(workspaceId, { key: "story", name: "Story" });

		await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Bug issue", typeId: bugTypeId },
		});
		await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Story issue", typeId: storyTypeId },
		});
		await mcpCall({ name: "create_issue", arguments: { projectId, title: "Untyped issue" } });

		const listResp = await mcpCall({ name: "list_issues", arguments: { typeId: bugTypeId } });
		expect(listResp.error).toBeUndefined();
		const page = JSON.parse(listResp.result!.content[0].text) as {
			items: Array<{ title: string }>;
		};
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Bug issue");
	});
});

describe("Issues KV cache", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
	});

	it("getIssue returns cached value on a second call (KV hit, D1 not re-read)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ projectId, title: "Cache me" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		// First GET populates KV cache
		const first = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});
		const firstIssue = (await first.json()) as { title: string };
		expect(firstIssue.title).toBe("Cache me");

		// Corrupt the D1 row directly — if the cache is skipped the title would change
		await env.DB.prepare("UPDATE issues SET title = 'D1 was read' WHERE id = ?").bind(id).run();

		// Second GET should return the cached value, not the corrupted D1 row
		const second = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});
		const secondIssue = (await second.json()) as { title: string };
		expect(secondIssue.title).toBe("Cache me");
	});

	it("updateIssue invalidates the cache so next getIssue re-fetches from D1", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ projectId, title: "Before update" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		// Warm the cache
		await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});

		// PATCH should invalidate the cache
		await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title: "After update" }),
		});

		// Next GET must reflect the new value (fetched from D1, not stale cache)
		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});
		const issue = (await getRes.json()) as { title: string };
		expect(issue.title).toBe("After update");
	});
});

describe("Issues role guards", () => {
	it("viewer cannot create an issue (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, title: "Should fail" }),
		});
		expect(res.status).toBe(403);
	});

	it("viewer cannot update an issue (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);

		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, title: "Issue to patch" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Hacked" }),
		});
		expect(patchRes.status).toBe(403);
	});

	it("member cannot delete an issue (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);

		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, title: "Issue to delete" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "DELETE",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(403);
	});

	it("owner can delete an issue", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);

		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ projectId: project.id, title: "Issue to delete" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "DELETE",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(200);
	});
});

describe("get_prioritized_issues MCP tool", () => {
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

	async function callPrioritized(args: Record<string, unknown> = {}) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_prioritized_issues", arguments: args },
			}),
		});
		return res.json() as Promise<{
			result?: { content: Array<{ text: string }> };
			error?: { code: number; message: string };
		}>;
	}

	it("returns [] (not 500) when no open issues exist", async () => {
		const body = await callPrioritized();
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: unknown[] };
		expect(Array.isArray(data.issues)).toBe(true);
		expect(data.issues).toHaveLength(0);
	});

	it("returns non-empty array with _score fields when open issues exist", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "High prio", priority: "high" });
		await seedIssue(workspaceId, projectId, userId, { title: "Low prio", priority: "low" });

		const body = await callPrioritized();
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as {
			issues: Array<{
				title: string;
				_score: number;
				_score_breakdown: { centrality: number; priority: number; story_points: number };
			}>;
		};
		expect(data.issues.length).toBeGreaterThan(0);
		expect(data.issues.some((i) => i.title === "High prio")).toBe(true);
		for (const issue of data.issues) {
			expect(typeof issue._score).toBe("number");
			expect(issue._score_breakdown).toHaveProperty("centrality");
			expect(issue._score_breakdown).toHaveProperty("priority");
			expect(issue._score_breakdown).toHaveProperty("story_points");
		}
	});

	it("handles more open issues than a single D1 query can bind (chunked enrichment)", async () => {
		// getPrioritizedIssues fetches every open issue, then batch-loads links + story points
		// keyed by those ids. On real D1 (100-param cap) an un-chunked load throws once there
		// are ~100 open issues; this guards the inChunks split and that results merge across
		// chunk boundaries. (SQLite's cap is higher, so this asserts correctness, not the cap.)
		const COUNT = 105;
		for (let i = 0; i < COUNT; i++) {
			await seedIssue(workspaceId, projectId, userId, { title: `Open ${i}`, priority: "medium" });
		}

		const body = await callPrioritized({ limit: 100 });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: Array<{ title: string }> };
		expect(data.issues).toHaveLength(100);
	});

	it("excludes done and cancelled issues", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Open" });
		await seedIssue(workspaceId, projectId, userId, { title: "Done", status: "done" });
		await seedIssue(workspaceId, projectId, userId, { title: "Cancelled", status: "cancelled" });

		const body = await callPrioritized();
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: Array<{ title: string }> };
		const titles = data.issues.map((i) => i.title);
		expect(titles).toContain("Open");
		expect(titles).not.toContain("Done");
		expect(titles).not.toContain("Cancelled");
	});

	it("scores issues with story points correctly (smaller SP = higher score)", async () => {
		const field = await seedCustomFieldDef(workspaceId, {
			key: "story_points",
			label: "Story Points",
			type: "number",
		});
		const small = await seedIssue(workspaceId, projectId, userId, {
			title: "Small",
			priority: "none",
		});
		const large = await seedIssue(workspaceId, projectId, userId, {
			title: "Large",
			priority: "none",
		});
		await seedCustomFieldValue(small.id, field.id, "1");
		await seedCustomFieldValue(large.id, field.id, "8");

		const body = await callPrioritized();
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as {
			issues: Array<{ title: string; _score: number }>;
		};
		const smallRow = data.issues.find((i) => i.title === "Small");
		const largeRow = data.issues.find((i) => i.title === "Large");
		expect(smallRow!._score).toBeGreaterThan(largeRow!._score);
	});
});
