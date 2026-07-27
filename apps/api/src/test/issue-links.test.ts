import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedIssue, seedProject, seedWorkspaceRoles } from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Issue Links API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let issueA: { id: string };
	let issueB: { id: string };
	let issueC: { id: string };

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
		issueA = await seedIssue(workspaceId, projectId, userId, { title: "Issue A" });
		issueB = await seedIssue(workspaceId, projectId, userId, { title: "Issue B" });
		issueC = await seedIssue(workspaceId, projectId, userId, { title: "Issue C" });
	});

	async function createLink(sourceIssueId: string, targetIssueId: string, type: string) {
		return SELF.fetch(`http://localhost/api/issues/${sourceIssueId}/links`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ targetIssueId, type }),
		});
	}

	async function listLinks(issueId: string) {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/links`, {
			headers: authHeaders(token, slug),
		});
		return { res, links: (await res.json()) as Array<Record<string, unknown>> };
	}

	it("creates a blocks link and lists it from both sides", async () => {
		const createRes = await createLink(issueA.id, issueB.id, "blocks");
		expect(createRes.status).toBe(201);
		const { id: linkId } = (await createRes.json()) as { id: string };
		expect(linkId).toBeTruthy();

		// From A's perspective: A blocks B
		const { links: aLinks } = await listLinks(issueA.id);
		expect(aLinks).toHaveLength(1);
		expect(aLinks[0].type).toBe("blocks");
		expect(aLinks[0].linkedIssueId).toBe(issueB.id);

		// From B's perspective: B is blocked_by A
		const { links: bLinks } = await listLinks(issueB.id);
		expect(bLinks).toHaveLength(1);
		expect(bLinks[0].type).toBe("blocked_by");
		expect(bLinks[0].linkedIssueId).toBe(issueA.id);
	});

	it("creates a blocked_by link and stores it canonically", async () => {
		// A blocked_by B → stored as B blocks A
		const createRes = await createLink(issueA.id, issueB.id, "blocked_by");
		expect(createRes.status).toBe(201);

		// From A's perspective: blocked_by B
		const { links: aLinks } = await listLinks(issueA.id);
		expect(aLinks[0].type).toBe("blocked_by");
		expect(aLinks[0].linkedIssueId).toBe(issueB.id);

		// From B's perspective: blocks A
		const { links: bLinks } = await listLinks(issueB.id);
		expect(bLinks[0].type).toBe("blocks");
		expect(bLinks[0].linkedIssueId).toBe(issueA.id);
	});

	it("creates a relates_to link (symmetric)", async () => {
		const createRes = await createLink(issueA.id, issueB.id, "relates_to");
		expect(createRes.status).toBe(201);

		const { links: aLinks } = await listLinks(issueA.id);
		expect(aLinks[0].type).toBe("relates_to");

		const { links: bLinks } = await listLinks(issueB.id);
		expect(bLinks[0].type).toBe("relates_to");
	});

	it("creates a duplicates link", async () => {
		const createRes = await createLink(issueA.id, issueB.id, "duplicates");
		expect(createRes.status).toBe(201);

		const { links: aLinks } = await listLinks(issueA.id);
		expect(aLinks[0].type).toBe("duplicates");
	});

	it("rejects self-links", async () => {
		const res = await createLink(issueA.id, issueA.id, "blocks");
		expect(res.status).toBe(400);
	});

	it("rejects duplicate pairs", async () => {
		await createLink(issueA.id, issueB.id, "blocks");
		const res = await createLink(issueA.id, issueB.id, "blocks");
		expect(res.status).toBe(409);
	});

	it("rejects duplicate pairs regardless of direction for symmetric types", async () => {
		await createLink(issueA.id, issueB.id, "relates_to");
		// Reverse direction should also be rejected (same canonical pair)
		const res = await createLink(issueB.id, issueA.id, "relates_to");
		expect(res.status).toBe(409);
	});

	it("rejects duplicate blocks/blocked_by pairs", async () => {
		await createLink(issueA.id, issueB.id, "blocks");
		// blocked_by is the same canonical pair
		const res = await createLink(issueB.id, issueA.id, "blocked_by");
		expect(res.status).toBe(409);
	});

	it("deletes a link", async () => {
		const createRes = await createLink(issueA.id, issueB.id, "relates_to");
		const { id: linkId } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/issues/${issueA.id}/links/${linkId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(deleteRes.status).toBe(200);

		const { links } = await listLinks(issueA.id);
		expect(links).toHaveLength(0);
	});

	it("returns 404 when deleting nonexistent link", async () => {
		const res = await SELF.fetch(
			`http://localhost/api/issues/${issueA.id}/links/${crypto.randomUUID()}`,
			{ method: "DELETE", headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(404);
	});

	it("links are cascade-deleted when an issue is deleted", async () => {
		await createLink(issueA.id, issueB.id, "blocks");

		// Delete issueA
		await SELF.fetch(`http://localhost/api/issues/${issueA.id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});

		// The link should be gone from issueB's perspective
		const { links } = await listLinks(issueB.id);
		expect(links).toHaveLength(0);
	});

	it("does not return links from another workspace", async () => {
		// Create a second workspace with its own issue
		const fixture2 = await seedFixture();
		const project2 = await seedProject(fixture2.workspace.id);
		const issueOther = await seedIssue(fixture2.workspace.id, project2.id, fixture2.user.id);

		// Directly insert a link into the DB scoped to workspace2 referencing issueOther and issueA
		// (won't happen via API due to workspace isolation, but checks the service layer)
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO issue_links (id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				fixture2.workspace.id,
				issueOther.id,
				issueOther.id === issueA.id ? issueB.id : issueOther.id,
				"relates_to",
				fixture2.user.id,
				now
			)
			.run();

		// workspace1's issueA should still have no links
		const { links } = await listLinks(issueA.id);
		expect(links).toHaveLength(0);
	});

	it("getIssue includes links array", async () => {
		await createLink(issueA.id, issueB.id, "blocks");
		await createLink(issueA.id, issueC.id, "relates_to");

		const res = await SELF.fetch(`http://localhost/api/issues/${issueA.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const issue = (await res.json()) as { links: Array<Record<string, unknown>> };
		expect(Array.isArray(issue.links)).toBe(true);
		expect(issue.links).toHaveLength(2);
	});
});

describe("Issue Links role guards", () => {
	it("viewer cannot create a link (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		const issue1 = await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "A",
		});
		const issue2 = await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "B",
		});

		const res = await SELF.fetch(`http://localhost/api/issues/${issue1.id}/links`, {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ targetIssueId: issue2.id, type: "relates_to" }),
		});
		expect(res.status).toBe(403);
	});

	it("viewer cannot delete a link (403)", async () => {
		const roles = await seedWorkspaceRoles();
		const project = await seedProject(roles.workspace.id);
		const issue1 = await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "A",
		});
		const issue2 = await seedIssue(roles.workspace.id, project.id, roles.owner.user.id, {
			title: "B",
		});

		const createRes = await SELF.fetch(`http://localhost/api/issues/${issue1.id}/links`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ targetIssueId: issue2.id, type: "relates_to" }),
		});
		const { id: linkId } = (await createRes.json()) as { id: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/issues/${issue1.id}/links/${linkId}`, {
			method: "DELETE",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(403);
	});
});

// PROJ-438: same as comments — the URL carries a ref, so the read takes one.
describe("PROJ-438 — links accept an issue ref", () => {
	it("GET /:ref/links returns the same links as GET /:uuid/links", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const slug = fixture.workspace.slug;
		const project = await seedProject(fixture.workspace.id);
		const a = await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { title: "A" });
		const b = await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { title: "B" });

		await SELF.fetch(`http://localhost/api/issues/${a.id}/links`, {
			method: "POST",
			headers: authHeaders(fixture.token, slug),
			body: JSON.stringify({ targetIssueId: b.id, type: "blocks" }),
		});

		const detail = await SELF.fetch(`http://localhost/api/issues/${a.id}`, {
			headers: authHeaders(fixture.token, slug),
		});
		const { project_key: key, number } = (await detail.json()) as {
			project_key: string;
			number: number;
		};

		const byRef = await SELF.fetch(`http://localhost/api/issues/${key}-${number}/links`, {
			headers: authHeaders(fixture.token, slug),
		});
		const byUuid = await SELF.fetch(`http://localhost/api/issues/${a.id}/links`, {
			headers: authHeaders(fixture.token, slug),
		});

		expect(byRef.status).toBe(200);
		expect(await byRef.json()).toEqual(await byUuid.json());
	});

	// Same key and number in both workspaces on purpose — see the matching test in
	// comments.test.ts for why distinct keys would let this pass with the resolver's
	// workspace filter removed.
	it("resolves a colliding ref inside the caller's own workspace", async () => {
		const mine = await seedFixture({ role: "owner" });
		const myProject = await seedProject(mine.workspace.id, "DUP");
		const a = await seedIssue(mine.workspace.id, myProject.id, mine.user.id, { title: "A" });
		const b = await seedIssue(mine.workspace.id, myProject.id, mine.user.id, { title: "B" });
		await SELF.fetch(`http://localhost/api/issues/${a.id}/links`, {
			method: "POST",
			headers: authHeaders(mine.token, mine.workspace.slug),
			body: JSON.stringify({ targetIssueId: b.id, type: "blocks" }),
		});

		const theirs = await seedFixture({ role: "owner" });
		const theirProject = await seedProject(theirs.workspace.id, "DUP");
		await seedIssue(theirs.workspace.id, theirProject.id, theirs.user.id, { title: "Not yours" });

		const res = await SELF.fetch("http://localhost/api/issues/DUP-1/links", {
			headers: authHeaders(mine.token, mine.workspace.slug),
		});

		expect(res.status).toBe(200);
		const links = (await res.json()) as Array<{ linkedIssueId: string }>;
		expect(links.map((l) => l.linkedIssueId)).toEqual([b.id]);
	});

	it("a ref that exists only in another workspace is 404", async () => {
		const mine = await seedFixture({ role: "owner" });
		const theirs = await seedFixture({ role: "owner" });
		const theirProject = await seedProject(theirs.workspace.id, "OTHER");
		await seedIssue(theirs.workspace.id, theirProject.id, theirs.user.id, { title: "Not yours" });

		const res = await SELF.fetch("http://localhost/api/issues/OTHER-1/links", {
			headers: authHeaders(mine.token, mine.workspace.slug),
		});

		expect(res.status).toBe(404);
	});

	// Writes were deliberately left UUID-only — they're never on a first-paint path.
	it("POST /:ref/links is still rejected — writes did not widen", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const project = await seedProject(fixture.workspace.id);
		await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { title: "A" });
		const b = await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { title: "B" });

		const res = await SELF.fetch(`http://localhost/api/issues/${project.key}-1/links`, {
			method: "POST",
			headers: authHeaders(fixture.token, fixture.workspace.slug),
			body: JSON.stringify({ targetIssueId: b.id, type: "blocks" }),
		});

		expect(res.status).toBe(400);
	});
});
