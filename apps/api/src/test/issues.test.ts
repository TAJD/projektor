import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ListIssuesSchema } from "../schemas/issues";
import {
	authHeaders,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedMember,
	seedProject,
	seedProjectFixture,
	seedTaskStatus,
	seedTaskType,
	seedUser,
	seedWorkspaceRoles,
} from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Issues API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	type IssuesPage = {
		items: Array<Record<string, unknown>>;
		nextCursor: number | null;
		total: number;
	};

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

	// PROJ-396: author_kind is stamped from the authenticated principal type, not a
	// caller-supplied field — same convention as issue_comments.author_kind (PROJ-328).
	// Tests authenticate over Bearer tokens (see authHeaders), same as agents.
	it("stamps author_kind from the auth transport, not a caller-supplied field", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Author kind test", authorKind: "human" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };

		const row = await env.DB.prepare("SELECT author_kind FROM issues WHERE id = ?")
			.bind(body.id)
			.first<{ author_kind: string | null }>();
		expect(row?.author_kind).toBe("agent");
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

	it("exposes a resolvable url on list items and single-issue fetches (PROJ-307)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Wiki full-text search" }),
		});
		const created = (await createRes.json()) as { id: string; number: number };

		const { page } = await listIssues();
		expect(page.items[0].url).toBe(`/projects/PROJ/issues/${created.number}/wiki-full-text-search`);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${created.id}`, {
			headers: authHeaders(token, slug),
		});
		const fetched = (await getRes.json()) as { url: string };
		expect(fetched.url).toBe(`/projects/PROJ/issues/${created.number}/wiki-full-text-search`);
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

	it("defaults to 30 rows per page when no limit is given (PROJ-201)", async () => {
		const base = 1_700_000_000;
		for (let i = 0; i < 35; i++) {
			await seedIssue(workspaceId, projectId, userId, {
				title: `Issue ${i}`,
				createdAt: base + i,
			});
		}

		// No explicit limit → the service default (30) applies, with a cursor for the rest.
		const { page: first } = await listIssues("http://localhost/api/issues");
		expect(first.items).toHaveLength(30);
		expect(first.nextCursor).not.toBeNull();

		const { page: second } = await listIssues(
			`http://localhost/api/issues?cursor=${first.nextCursor}`
		);
		expect(second.items).toHaveLength(5);
		expect(second.nextCursor).toBeNull();
	}, 15000); // PROJ-248: seeds 35 issues sequentially; full-suite contention pushes this past the 5s default

	it("reports the real total match count, not just the loaded page size (PROJ-303)", async () => {
		const base = 1_700_000_000;
		for (let i = 0; i < 35; i++) {
			await seedIssue(workspaceId, projectId, userId, {
				title: `Issue ${i}`,
				createdAt: base + i,
			});
		}

		// The first page only loads 30 rows, but `total` must reflect all 35 matches —
		// this is what the frontend header count relies on instead of items.length.
		const { page: first } = await listIssues("http://localhost/api/issues");
		expect(first.items).toHaveLength(30);
		expect(first.total).toBe(35);

		const { page: second } = await listIssues(
			`http://localhost/api/issues?cursor=${first.nextCursor}`
		);
		expect(second.total).toBe(35);
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
	}, 15000); // PROJ-248: seeds 65 issues sequentially; full-suite contention pushes this past the 5s default

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
		const issue = (await getRes.json()) as { title: string; project_key: string };
		expect(issue.title).toBe("Ref issue");
		expect(issue.project_key).toBe("PROJ");
	});

	it("GET /api/issues/KEY-NUMBER resolves for a project key containing digits (PROJ-440)", async () => {
		const digitProject = await seedProject(workspaceId, "WEB2");
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId: digitProject.id, title: "Digit-key ref issue" }),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { id: string; number: number };

		const getRes = await SELF.fetch(`http://localhost/api/issues/WEB2-${created.number}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
		const issue = (await getRes.json()) as { title: string; project_key: string };
		expect(issue.title).toBe("Digit-key ref issue");
		expect(issue.project_key).toBe("WEB2");

		const commentsRes = await SELF.fetch(
			`http://localhost/api/issues/WEB2-${created.number}/comments`,
			{ headers: authHeaders(token, slug) }
		);
		expect(commentsRes.status).toBe(200);

		const linksRes = await SELF.fetch(`http://localhost/api/issues/WEB2-${created.number}/links`, {
			headers: authHeaders(token, slug),
		});
		expect(linksRes.status).toBe(200);
	});

	it("GET /api/issues/:ref with an absurdly long number is a 404, not a 500 (PROJ-440)", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/PROJ-${"9".repeat(400)}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/issues/:id includes project_key (PROJ-226 tab title regression)", async () => {
		const created = await seedIssue(workspaceId, projectId, userId, { title: "By id" });

		const getRes = await SELF.fetch(`http://localhost/api/issues/${created.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
		const issue = (await getRes.json()) as { project_key: string };
		expect(issue.project_key).toBe("PROJ");
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

	it("PROJ-389: another workspace's owner cannot create an issue in this project", async () => {
		const other = await seedFixture({ role: "owner" });
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ projectId, title: "Cross-workspace write" }),
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

	// ─── PROJ-212: completed_at + date-range filters ──────────────────────────
	// The test rate limiter allows only RATE_LIMIT_API_MAX (5) API requests per
	// window, so set up state via env.DB and assert via env.DB where possible —
	// DB access bypasses both the rate limiter and the getIssue KV cache.
	async function patch(id: string, body: Record<string, unknown>) {
		return SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	async function completedAtOf(id: string): Promise<number | null> {
		const row = await env.DB.prepare("SELECT completed_at FROM issues WHERE id = ?")
			.bind(id)
			.first<{ completed_at: number | null }>();
		return row?.completed_at ?? null;
	}

	it("stamps completed_at when an issue enters a done status and clears it on exit (PROJ-212)", async () => {
		// 3 API requests (DB seed + 3 patch), under the rate-limit window.
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Will complete" });
		const id = issue.id;
		expect(await completedAtOf(id)).toBeNull();

		await patch(id, {
			status: "done",
			completionReport: { summary: "Done", verification: "pnpm test" },
		});
		const completed = await completedAtOf(id);
		expect(typeof completed).toBe("number");

		// Re-saving while still done keeps the original completion time.
		await patch(id, { priority: "high" });
		expect(await completedAtOf(id)).toBe(completed);

		// Leaving done clears it.
		await patch(id, { status: "in_progress" });
		expect(await completedAtOf(id)).toBeNull();
	});

	it("filters by completedAfter / completedBefore (PROJ-212)", async () => {
		// Seed + stamp completion via env.DB so only the 2 list calls hit the API.
		const older = await seedIssue(workspaceId, projectId, userId, { title: "Completed long ago" });
		const recent = await seedIssue(workspaceId, projectId, userId, { title: "Completed just now" });
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare("UPDATE issues SET completed_at = ? WHERE id = ?")
			.bind(now - 10 * 86400, older.id)
			.run();
		await env.DB.prepare("UPDATE issues SET completed_at = ? WHERE id = ?")
			.bind(now, recent.id)
			.run();

		const cutoff = now - 86400; // 1 day ago

		const before = await listIssues(`http://localhost/api/issues?completedBefore=${cutoff}`);
		expect((before.page.items as Array<{ title: string }>).map((i) => i.title)).toEqual([
			"Completed long ago",
		]);

		const after = await listIssues(`http://localhost/api/issues?completedAfter=${cutoff}`);
		expect((after.page.items as Array<{ title: string }>).map((i) => i.title)).toEqual([
			"Completed just now",
		]);
	});

	it("filters by updatedAfter / updatedBefore (PROJ-212)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const stale = await seedIssue(workspaceId, projectId, userId, { title: "Edited long ago" });
		const fresh = await seedIssue(workspaceId, projectId, userId, { title: "Edited just now" });
		await env.DB.prepare("UPDATE issues SET updated_at = ? WHERE id = ?")
			.bind(now - 10 * 86400, stale.id)
			.run();
		await env.DB.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").bind(now, fresh.id).run();

		const cutoff = now - 86400;

		const before = await listIssues(`http://localhost/api/issues?updatedBefore=${cutoff}`);
		expect((before.page.items as Array<{ title: string }>).map((i) => i.title)).toEqual([
			"Edited long ago",
		]);

		const after = await listIssues(`http://localhost/api/issues?updatedAfter=${cutoff}`);
		expect((after.page.items as Array<{ title: string }>).map((i) => i.title)).toEqual([
			"Edited just now",
		]);
	});

	// ─── PROJ-252: flow timestamps (ready_at/claimed_at/done_at) ──────────────
	async function flowTimestampsOf(
		id: string
	): Promise<{ ready_at: number | null; claimed_at: number | null; done_at: number | null }> {
		const row = await env.DB.prepare(
			"SELECT ready_at, claimed_at, done_at FROM issues WHERE id = ?"
		)
			.bind(id)
			.first<{ ready_at: number | null; claimed_at: number | null; done_at: number | null }>();
		return row ?? { ready_at: null, claimed_at: null, done_at: null };
	}

	it("stamps ready_at/claimed_at/done_at once, on first entry, and never clears them", async () => {
		// 4 API requests (seed + 4 patches), under the rate-limit window.
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Flows through" });
		const id = issue.id;
		expect(await flowTimestampsOf(id)).toEqual({ ready_at: null, claimed_at: null, done_at: null });

		await patch(id, { status: "todo" });
		const afterReady = await flowTimestampsOf(id);
		expect(typeof afterReady.ready_at).toBe("number");
		expect(afterReady.claimed_at).toBeNull();
		expect(afterReady.done_at).toBeNull();

		await patch(id, { status: "in_progress" });
		const afterClaimed = await flowTimestampsOf(id);
		expect(afterClaimed.ready_at).toBe(afterReady.ready_at);
		expect(typeof afterClaimed.claimed_at).toBe("number");
		expect(afterClaimed.done_at).toBeNull();

		await patch(id, {
			status: "done",
			completionReport: { summary: "Done", verification: "pnpm test" },
		});
		const afterDone = await flowTimestampsOf(id);
		expect(typeof afterDone.done_at).toBe("number");

		// Reopening does not clear done_at (unlike completed_at) — it's write-once history.
		await patch(id, { status: "in_progress" });
		const afterReopen = await flowTimestampsOf(id);
		expect(afterReopen.ready_at).toBe(afterReady.ready_at);
		expect(afterReopen.claimed_at).toBe(afterClaimed.claimed_at);
		expect(afterReopen.done_at).toBe(afterDone.done_at);
	});

	it("stamps ready_at even when an issue skips straight from backlog to in_progress", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Fast-tracked" });
		await patch(issue.id, { status: "in_progress" });
		const stamps = await flowTimestampsOf(issue.id);
		expect(typeof stamps.ready_at).toBe("number");
		expect(typeof stamps.claimed_at).toBe("number");
	});

	// ─── PROJ-328: in_review_at + review_bounce_count ──────────────
	async function reviewFieldsOf(
		id: string
	): Promise<{ in_review_at: number | null; review_bounce_count: number }> {
		const row = await env.DB.prepare(
			"SELECT in_review_at, review_bounce_count FROM issues WHERE id = ?"
		)
			.bind(id)
			.first<{ in_review_at: number | null; review_bounce_count: number }>();
		return row ?? { in_review_at: null, review_bounce_count: 0 };
	}

	it("stamps in_review_at once, on first entry, and counts bounces back to in_progress", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Reviewed and bounced",
		});
		const id = issue.id;

		await patch(id, { status: "in_progress" });
		expect(await reviewFieldsOf(id)).toEqual({ in_review_at: null, review_bounce_count: 0 });

		await patch(id, { status: "in_review" });
		const afterReview = await reviewFieldsOf(id);
		expect(typeof afterReview.in_review_at).toBe("number");
		expect(afterReview.review_bounce_count).toBe(0);

		await patch(id, { status: "in_progress" });
		const afterBounce = await reviewFieldsOf(id);
		expect(afterBounce.in_review_at).toBe(afterReview.in_review_at);
		expect(afterBounce.review_bounce_count).toBe(1);

		await patch(id, { status: "in_review" });
		const afterReReview = await reviewFieldsOf(id);
		// Write-once: re-entering review does not restamp in_review_at.
		expect(afterReReview.in_review_at).toBe(afterReview.in_review_at);
		expect(afterReReview.review_bounce_count).toBe(1);

		await patch(id, {
			status: "done",
			completionReport: { summary: "Done", verification: "pnpm test" },
		});
		const afterDone = await reviewFieldsOf(id);
		// Going from review straight to done is not a bounce.
		expect(afterDone.review_bounce_count).toBe(1);
	});

	// ─── PROJ-334: gate rejections (in_review -> in_progress specifically) ──────
	async function gateRejectionCountOf(id: string): Promise<number> {
		const row = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM issue_gate_rejections WHERE issue_id = ?"
		)
			.bind(id)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	// Split into two tests (each gets a fresh token from beforeEach) — the test rate
	// limiter allows only RATE_LIMIT_API_MAX (5) requests per token per window, and
	// each case alone already needs 3 patches.
	it("records a gate-rejection event for in_review -> in_progress", async () => {
		const rejected = await seedIssue(workspaceId, projectId, userId, { title: "Sent back" });
		await patch(rejected.id, { status: "in_progress" });
		await patch(rejected.id, { status: "in_review" });
		await patch(rejected.id, { status: "in_progress" });
		expect(await gateRejectionCountOf(rejected.id)).toBe(1);
		// review_bounce_count still counts it (PROJ-328's aggregate is unchanged).
		expect((await reviewFieldsOf(rejected.id)).review_bounce_count).toBe(1);
	});

	it("does not record a gate-rejection event for in_review -> cancelled", async () => {
		const killed = await seedIssue(workspaceId, projectId, userId, { title: "Killed in review" });
		await patch(killed.id, { status: "in_progress" });
		await patch(killed.id, { status: "in_review" });
		await patch(killed.id, { status: "cancelled" });
		// Not a gate rejection — the issue was cancelled, not sent back for rework —
		// even though the aggregate reviewBounceCount still increments for it.
		expect(await gateRejectionCountOf(killed.id)).toBe(0);
		expect((await reviewFieldsOf(killed.id)).review_bounce_count).toBe(1);
	});
});

// ─── PROJ-441/442/444: list-endpoint perf sweep ──────────────────────────────
describe("Issues API — includeRollups/includeBody/assignee=me (perf sweep)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function listIssues(url: string) {
		const res = await SELF.fetch(url, { headers: authHeaders(token, slug) });
		return { res, page: (await res.json()) as { items: Array<Record<string, unknown>> } };
	}

	// PROJ-441
	it("includeRollups=1 attaches a rollup per item for parents with mixed-status children", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Parent with children" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "backlog" });
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "backlog" });
		await seedIssue(workspaceId, projectId, userId, { parentId, status: "done" });

		const { page } = await listIssues(`http://localhost/api/issues?noParent=true&includeRollups=1`);
		const parentItem = page.items.find((i) => i.id === parentId) as {
			rollup: { total: number; byStatus: Record<string, number>; done: number; remaining: number };
		};
		expect(parentItem).toBeDefined();
		expect(parentItem.rollup.total).toBe(3);
		expect(parentItem.rollup.byStatus.backlog).toBe(2);
		expect(parentItem.rollup.byStatus.done).toBe(1);
		expect(parentItem.rollup.done).toBe(1);
		expect(parentItem.rollup.remaining).toBe(2);
	});

	it("without includeRollups, items carry no rollup key", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "No rollup wanted" }),
		});
		const { page } = await listIssues("http://localhost/api/issues");
		expect(page.items).toHaveLength(1);
		expect("rollup" in page.items[0]).toBe(false);
	});

	it("includeRollups counts children in a different project the same as getIssue's own rollup", async () => {
		const otherProject = await seedProject(workspaceId, "OTH");
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Cross-project parent" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };
		await seedIssue(workspaceId, otherProject.id, userId, { parentId, status: "done" });

		// getIssue's own rollup (unaffected by this change) — the baseline to match.
		const getRes = await SELF.fetch(`http://localhost/api/issues/${parentId}`, {
			headers: authHeaders(token, slug),
		});
		const single = (await getRes.json()) as { rollup: { total: number; done: number } };
		expect(single.rollup.total).toBe(1);
		expect(single.rollup.done).toBe(1);

		const { page } = await listIssues(`http://localhost/api/issues?noParent=true&includeRollups=1`);
		const parentItem = page.items.find((i) => i.id === parentId) as {
			rollup: { total: number; done: number };
		};
		expect(parentItem.rollup.total).toBe(single.rollup.total);
		expect(parentItem.rollup.done).toBe(single.rollup.done);
	});

	it("includeRollups groups by raw status even when status_category diverges, matching getIssue", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Category-divergent parent" }),
		});
		const { id: parentId } = (await parentRes.json()) as { id: string };
		const { id: childId } = await seedIssue(workspaceId, projectId, userId, {
			parentId,
			status: "backlog",
		});
		// Custom-status issues carry a status_category distinct from their raw status;
		// the list rollup must still key byStatus on the raw status like getIssue does.
		await env.DB.prepare("UPDATE issues SET status_category = 'done' WHERE id = ?")
			.bind(childId)
			.run();

		const getRes = await SELF.fetch(`http://localhost/api/issues/${parentId}`, {
			headers: authHeaders(token, slug),
		});
		const single = (await getRes.json()) as {
			rollup: { total: number; byStatus: Record<string, number>; done: number };
		};

		const { page } = await listIssues(`http://localhost/api/issues?noParent=true&includeRollups=1`);
		const parentItem = page.items.find((i) => i.id === parentId) as {
			rollup: { total: number; byStatus: Record<string, number>; done: number };
		};
		expect(parentItem.rollup).toEqual(single.rollup);
		expect(parentItem.rollup.byStatus).toEqual({ backlog: 1 });
		expect(parentItem.rollup.done).toBe(0);
	});

	// PROJ-442
	it("list items omit body by default; includeBody=1 restores it", async () => {
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Has a body", body: "Some body text" }),
		});

		const { page: defaultPage } = await listIssues("http://localhost/api/issues");
		expect(defaultPage.items).toHaveLength(1);
		expect("body" in defaultPage.items[0]).toBe(false);

		const { page: withBody } = await listIssues("http://localhost/api/issues?includeBody=1");
		expect(withBody.items[0].body).toBe("Some body text");
	});

	// PROJ-444
	it("assignee=me returns the calling user's issues", async () => {
		const other = await seedUser("me-filter-other@example.com");
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Assigned to me", assigneeId: userId }),
		});
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Assigned to someone else", assigneeId: other.id }),
		});

		const { page } = await listIssues("http://localhost/api/issues?assignee=me");
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Assigned to me");
	});

	it("assignee filter still accepts a literal user id", async () => {
		const other = await seedUser("literal-id-filter@example.com");
		await seedMember(workspaceId, other.id);
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Assigned to other", assigneeId: other.id }),
		});

		const { page } = await listIssues(`http://localhost/api/issues?assignee=${other.id}`);
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Assigned to other");
	});
});

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
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

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Issues MCP — list_issues filter parity (PROJ-243)", () => {
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

	it("advertises all ListIssuesSchema optional filter keys in its inputSchema", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		const body = (await res.json()) as {
			result: {
				tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
			};
		};
		const listIssuesTool = body.result.tools.find((t) => t.name === "list_issues");
		expect(listIssuesTool).toBeDefined();
		const advertised = Object.keys(listIssuesTool!.inputSchema.properties);
		for (const key of Object.keys(ListIssuesSchema.shape)) {
			expect(advertised).toContain(key);
		}
	});

	it("respects the noParent filter", async () => {
		const parentResp = await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Parent issue" },
		});
		const { id: parentId } = JSON.parse(parentResp.result!.content[0].text) as { id: string };
		await mcpCall({
			name: "create_issue",
			arguments: { projectId, title: "Child issue", parentId },
		});

		const listResp = await mcpCall({ name: "list_issues", arguments: { noParent: true } });
		expect(listResp.error).toBeUndefined();
		const page = JSON.parse(listResp.result!.content[0].text) as {
			items: Array<{ title: string }>;
		};
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Parent issue");
	});
});

describe("Issues KV cache", () => {
	let token: string;
	let slug: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, projectId } = await seedProjectFixture());
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

	// PROJ-359: ref lookups ("PROJ-42", the primary MCP agent read path) resolve
	// via fetchIssueByRef rather than the id-keyed cache check at the top of
	// getIssue, so they never got any cache benefit before this fix.
	it("getIssue by ref returns cached value on a second call (KV hit, D1 not re-read)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ projectId, title: "Cache me by ref" }),
		});
		const { id, number } = (await createRes.json()) as { id: string; number: number };
		const ref = `PROJ-${number}`;

		// First GET by ref populates KV cache
		const first = await SELF.fetch(`http://localhost/api/issues/${ref}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});
		const firstIssue = (await first.json()) as { title: string };
		expect(firstIssue.title).toBe("Cache me by ref");

		// Corrupt the D1 row directly — if the cache is skipped the title would change
		await env.DB.prepare("UPDATE issues SET title = 'D1 was read' WHERE id = ?").bind(id).run();

		// Second GET by ref should return the cached value, not the corrupted D1 row
		const second = await SELF.fetch(`http://localhost/api/issues/${ref}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
				"Content-Type": "application/json",
			},
		});
		const secondIssue = (await second.json()) as { title: string };
		expect(secondIssue.title).toBe("Cache me by ref");
	});
});

describe("Issues role guards", () => {
	it("viewer cannot create an issue (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		// PROJ-311: a viewer grant makes the project visible; the write is still denied.
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

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
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, project.id, "viewer");

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

// cofferdam-ignore: Readability.MaxFunctionLength: one describe block, normal test style
describe("get_prioritized_issues MCP tool", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
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
		const body = await callPrioritized({ includeNotReady: true });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: unknown[] };
		expect(Array.isArray(data.issues)).toBe(true);
		expect(data.issues).toHaveLength(0);
	});

	it("returns non-empty array with _score fields when open issues exist", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "High prio", priority: "high" });
		await seedIssue(workspaceId, projectId, userId, { title: "Low prio", priority: "low" });

		const body = await callPrioritized({ includeNotReady: true });
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

		const body = await callPrioritized({ limit: 100, includeNotReady: true });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: Array<{ title: string }> };
		expect(data.issues).toHaveLength(100);
	});

	it("excludes done and cancelled issues", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Open" });
		await seedIssue(workspaceId, projectId, userId, { title: "Done", status: "done" });
		await seedIssue(workspaceId, projectId, userId, { title: "Cancelled", status: "cancelled" });

		const body = await callPrioritized({ includeNotReady: true });
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

		const body = await callPrioritized({ includeNotReady: true });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as {
			issues: Array<{ title: string; _score: number }>;
		};
		const smallRow = data.issues.find((i) => i.title === "Small");
		const largeRow = data.issues.find((i) => i.title === "Large");
		expect(smallRow!._score).toBeGreaterThan(largeRow!._score);
	});

	// ─── PROJ-253: definition-of-ready filtering ──────────────────────────────
	it("drops not-ready issues by default, and surfaces them with includeNotReady", async () => {
		const ready = await seedIssue(workspaceId, projectId, userId, { title: "Ready" });
		await env.DB.prepare("UPDATE issues SET body = ? WHERE id = ?")
			.bind(
				[
					"## Acceptance criteria",
					"- Does the thing",
					"",
					"## Scope",
					"`src/thing.ts`",
					"",
					"## Verification",
					"`pnpm test`",
				].join("\n"),
				ready.id
			)
			.run();
		await seedIssue(workspaceId, projectId, userId, { title: "Not ready" });

		const defaultBody = await callPrioritized();
		const defaultParsed = JSON.parse(defaultBody.result!.content[0].text) as {
			issues: Array<{ title: string }>;
			droppedNotReady: number;
		};
		const defaultTitles = defaultParsed.issues.map((i) => i.title);
		expect(defaultTitles).toContain("Ready");
		expect(defaultTitles).not.toContain("Not ready");
		// PROJ-291: dropped not-ready issues are surfaced as a count, not silently gone.
		expect(defaultParsed.droppedNotReady).toBeGreaterThanOrEqual(1);

		const withNotReady = await callPrioritized({ includeNotReady: true });
		const data = JSON.parse(withNotReady.result!.content[0].text) as {
			issues: Array<{ title: string; needsGrooming?: boolean; missingCriteria?: string[] }>;
		};
		const notReadyRow = data.issues.find((i) => i.title === "Not ready");
		expect(notReadyRow?.needsGrooming).toBe(true);
		expect(notReadyRow?.missingCriteria).toEqual(
			expect.arrayContaining(["acceptance criteria", "scope/files", "verification"])
		);
		const readyRow = data.issues.find((i) => i.title === "Ready");
		expect(readyRow?.needsGrooming).toBeUndefined();
	});

	// ─── PROJ-324: projectId scoping ───────────────────────────────────────────
	it("scopes ranking to projectId, and droppedNotReady reflects only that project", async () => {
		const otherProject = await seedProject(workspaceId, "OTHER");
		await seedIssue(workspaceId, projectId, userId, { title: "In target project" });
		await seedIssue(workspaceId, otherProject.id, userId, { title: "In other project" });

		const body = await callPrioritized({ projectId, includeNotReady: true });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: Array<{ title: string }> };
		const titles = data.issues.map((i) => i.title);
		expect(titles).toContain("In target project");
		expect(titles).not.toContain("In other project");
	});

	it("computes droppedNotReady scoped to projectId", async () => {
		const otherProject = await seedProject(workspaceId, "OTHER");
		// Neither issue has a body, so both fail the definition-of-ready check.
		await seedIssue(workspaceId, projectId, userId, { title: "Not ready in target" });
		await seedIssue(workspaceId, otherProject.id, userId, { title: "Not ready in other" });

		const body = await callPrioritized({ projectId });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { droppedNotReady: number };
		expect(data.droppedNotReady).toBe(1);
	});

	it("workspace-wide behavior (no projectId) is unchanged", async () => {
		const otherProject = await seedProject(workspaceId, "OTHER");
		await seedIssue(workspaceId, projectId, userId, { title: "In target project" });
		await seedIssue(workspaceId, otherProject.id, userId, { title: "In other project" });

		const body = await callPrioritized({ includeNotReady: true });
		expect(body.error).toBeUndefined();
		const data = JSON.parse(body.result!.content[0].text) as { issues: Array<{ title: string }> };
		const titles = data.issues.map((i) => i.title);
		expect(titles).toContain("In target project");
		expect(titles).toContain("In other project");
	});
});
