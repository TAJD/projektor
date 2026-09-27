// PROJ-818: link titles fold case the same way on both sides (in JS, stored), so
// accented Latin titles resolve; and link reads never reveal pages in projects the
// caller can't see.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedProject, seedWorkspaceRoles } from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

async function call(url: string, token: string, slug: string, init?: RequestInit) {
	await resetRateLimits();
	return SELF.fetch(url, { ...init, headers: authHeaders(token, slug) });
}

async function createPage(
	token: string,
	slug: string,
	body: { title: string; content?: string; projectId?: string }
) {
	const res = await call("http://localhost/api/wiki", token, slug, {
		method: "POST",
		body: JSON.stringify({ content: "", ...body }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; slug: string };
}

async function broken(token: string, slug: string) {
	const res = await call("http://localhost/api/wiki/broken-links", token, slug);
	expect(res.status).toBe(200);
	return (await res.json()) as Array<{ sourceSlug: string; targetTitle: string }>;
}

async function targetOf(sourceId: string) {
	const row = await env.DB.prepare(
		"SELECT target_page_id AS t FROM wiki_links WHERE source_page_id = ?"
	)
		.bind(sourceId)
		.first<{ t: string | null }>();
	return row?.t ?? null;
}

describe("PROJ-818: accented Latin titles fold on both sides", () => {
	it("[[über uns]] resolves to a page titled 'Über uns'", async () => {
		const { token, workspace } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, { title: "Über uns" });
		const source = await createPage(token, workspace.slug, {
			title: "Home",
			content: "See [[über uns]].",
		});
		expect(await targetOf(source.id)).toBe(target.id);
	});

	it("a link written before the page exists resolves when 'Über uns' is created", async () => {
		const { token, workspace } = await seedFixture({ role: "owner" });
		const source = await createPage(token, workspace.slug, {
			title: "Home",
			content: "See [[ÜBER UNS]].",
		});
		expect(await targetOf(source.id)).toBeNull();
		const target = await createPage(token, workspace.slug, { title: "über uns" });
		expect(await targetOf(source.id)).toBe(target.id);
	});

	it("pre-migration rows with a NULL fold are healed before matching", async () => {
		const { token, workspace, user } = await seedFixture({ role: "owner" });
		const legacyId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO wiki_pages (id, workspace_id, slug, title, content, created_by_id, updated_by_id, created_at, updated_at)
			 VALUES (?, ?, 'legacy-uber', 'Über Legacy', '', ?, ?, 0, 0)`
		)
			.bind(legacyId, workspace.id, user.id, user.id)
			.run();
		const source = await createPage(token, workspace.slug, {
			title: "Links",
			content: "[[über legacy]]",
		});
		expect(await targetOf(source.id)).toBe(legacyId);
	});
});

describe("PROJ-818: link reads don't reveal pages in hidden projects", () => {
	it("a link to a page in a hidden project is reported broken, as written", async () => {
		const { workspace, owner, member } = await seedWorkspaceRoles();
		const hidden = await seedProject(workspace.id, "HID");
		await createPage(owner.token, workspace.slug, { title: "Secret Plan", projectId: hidden.id });
		const secretBySlug = await createPage(owner.token, workspace.slug, {
			title: "Other Secret Title",
			projectId: hidden.id,
		});
		// Workspace-level page (visible to everyone) linking into the hidden project.
		await createPage(owner.token, workspace.slug, {
			title: "Public Index",
			content: `[[Secret Plan]] and [x](/wiki/${secretBySlug.slug})`,
		});

		const asMember = await broken(member.token, workspace.slug);
		const fromIndex = asMember
			.filter((b) => b.sourceSlug === "public-index")
			.map((b) => b.targetTitle);
		expect(fromIndex.sort()).toEqual(["Secret Plan", secretBySlug.slug].sort());
		expect(fromIndex).not.toContain("Other Secret Title");

		// The owner can see the project: nothing broken.
		const asOwner = await broken(owner.token, workspace.slug);
		expect(asOwner.filter((b) => b.sourceSlug === "public-index")).toEqual([]);
	});
});
