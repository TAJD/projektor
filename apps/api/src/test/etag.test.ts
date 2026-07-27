import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	authHeaders,
	seedComment,
	seedFixture,
	seedIssue,
	seedIssueFixture,
	seedProject,
	seedProjectFixture,
} from "./helpers";

// PROJ-439: conditional GETs. The ETag is a hash of the response body, so a mutation
// that changes the body changes the tag by construction — there is no invalidation list
// to keep in step. What these tests protect is the part that isn't structural: that a
// 304 can only ever replace a 200 the same caller was already entitled to.

async function get(path: string, token: string, slug: string, ifNoneMatch?: string | null) {
	return SELF.fetch(`http://localhost${path}`, {
		headers: {
			...authHeaders(token, slug),
			...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
		},
	});
}

describe("PROJ-439 — ETag / conditional GET", () => {
	it("tags a 200 and answers a matching If-None-Match with an empty 304", async () => {
		const f = await seedIssueFixture({ role: "owner" });

		const first = await get(`/api/issues/${f.issueId}`, f.token, f.slug);
		expect(first.status).toBe(200);
		const etag = first.headers.get("ETag");
		expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
		expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

		const second = await get(`/api/issues/${f.issueId}`, f.token, f.slug, etag);
		expect(second.status).toBe(304);
		expect(await second.text()).toBe("");
		expect(second.headers.get("ETag")).toBe(etag);
		// Retained on the 304 so the browser keeps revalidating rather than falling back
		// to a heuristic freshness lifetime for the entry it just refreshed.
		expect(second.headers.get("Cache-Control")).toBe("private, no-cache");
	});

	it("accepts a weak validator and a comma-separated If-None-Match list", async () => {
		const f = await seedIssueFixture({ role: "owner" });
		const etag = (await get(`/api/issues/${f.issueId}`, f.token, f.slug)).headers.get("ETag");

		const weak = await get(`/api/issues/${f.issueId}`, f.token, f.slug, `W/${etag}`);
		expect(weak.status).toBe(304);

		const list = await get(`/api/issues/${f.issueId}`, f.token, f.slug, `"other", ${etag}`);
		expect(list.status).toBe(304);
	});

	it("does not 304 a stale validator", async () => {
		const f = await seedIssueFixture({ role: "owner" });
		const res = await get(`/api/issues/${f.issueId}`, f.token, f.slug, '"deadbeef"');
		expect(res.status).toBe(200);
	});

	// ---- a mutation must never leave a stale 304 behind ----

	it("PATCH to an issue makes the next conditional GET a 200 with the new content", async () => {
		const f = await seedIssueFixture({ role: "owner", issueTitle: "Before" });
		const etag = (await get(`/api/issues/${f.issueId}`, f.token, f.slug)).headers.get("ETag");

		const patch = await SELF.fetch(`http://localhost/api/issues/${f.issueId}`, {
			method: "PATCH",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ title: "After" }),
		});
		expect(patch.status).toBe(200);

		const after = await get(`/api/issues/${f.issueId}`, f.token, f.slug, etag);
		expect(after.status).toBe(200);
		expect((await after.json<{ title: string }>()).title).toBe("After");
		expect(after.headers.get("ETag")).not.toBe(etag);
	});

	it("a new comment makes the next conditional GET of the comment list a 200", async () => {
		const f = await seedIssueFixture({ role: "owner" });
		const path = `/api/issues/${f.issueId}/comments`;
		const etag = (await get(path, f.token, f.slug)).headers.get("ETag");

		const post = await SELF.fetch(`http://localhost${path}`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ body: "new comment" }),
		});
		expect(post.status).toBe(201);

		const after = await get(path, f.token, f.slug, etag);
		expect(after.status).toBe(200);
		expect(await after.json<unknown[]>()).toHaveLength(1);
	});

	it("creating a task status makes the next conditional GET of the list a 200", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const etag = (await get("/api/task-statuses", f.token, f.slug)).headers.get("ETag");

		const post = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ key: "triage", name: "Triage", category: "todo" }),
		});
		expect(post.status).toBe(201);

		const after = await get("/api/task-statuses", f.token, f.slug, etag);
		expect(after.status).toBe(200);
	});

	// ---- a 304 must never stand in for a 403 or a 404 ----
	//
	// Each of these replays a validator obtained by someone who *was* entitled to the
	// resource. That's the case that matters: an unauthorised caller who guesses or is
	// handed a valid ETag must still be refused, not handed an empty 304 that tells them
	// their copy is current.

	it("a non-member replaying a valid ETag gets 403, not 304", async () => {
		const owner = await seedIssueFixture({ role: "owner" });
		const etag = (await get(`/api/issues/${owner.issueId}`, owner.token, owner.slug)).headers.get(
			"ETag"
		);

		// A user with a token of their own, but no membership of the owner's workspace.
		const outsider = await seedFixture({ role: "owner" });

		const res = await get(`/api/issues/${owner.issueId}`, outsider.token, owner.slug, etag);
		expect(res.status).toBe(403);
		expect(res.headers.get("ETag")).toBeNull();
	});

	it("a cross-workspace token replaying a valid ETag gets 403, not 304", async () => {
		const owner = await seedIssueFixture({ role: "owner" });
		const etag = (await get(`/api/issues/${owner.issueId}`, owner.token, owner.slug)).headers.get(
			"ETag"
		);

		// API tokens are workspace-scoped (PROJ-16). Pointing one at another workspace's
		// slug is refused by the confinement check, which runs ahead of the membership
		// check — so this 403 is the token scope, distinct from the non-member case above.
		const other = await seedFixture({ role: "owner" });

		const res = await get(`/api/issues/${owner.issueId}`, other.token, owner.slug, etag);
		expect(res.status).toBe(403);
	});

	it("a member with no project grant replaying a valid ETag gets 404, not 304", async () => {
		// PROJ-311 access is default-deny per project, so this is the in-workspace
		// equivalent of the two cases above.
		const f = await seedProjectFixture({ role: "member" });
		const ungranted = await seedProject(f.workspaceId, "NOGRANT");
		const issue = await seedIssue(f.workspaceId, ungranted.id, f.userId, { title: "Invisible" });
		await seedComment(issue.id, f.userId, "secret");

		const denied = await get(`/api/issues/${issue.id}/comments`, f.token, f.slug, '"anything"');
		expect(denied.status).toBe(404);
		expect(denied.headers.get("ETag")).toBeNull();
	});

	it("does not tag a non-200, so an error body can never become a 304", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const missing = await get(`/api/issues/${crypto.randomUUID()}`, f.token, f.slug);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("ETag")).toBeNull();
		expect(missing.headers.get("Cache-Control")).toBeNull();
	});
});
