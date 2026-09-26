// PROJ-809 / PROJ-810: wiki reads carry their revision pointer, and every content
// write is guarded so a concurrent write can't be silently reverted.

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../services/errors";
import type { ServiceCtx } from "../services/types";
import {
	createWikiPage,
	getWikiPage,
	listWikiRevisions,
	patchWikiPage,
	updateWikiPage,
} from "../services/wiki";
import { authHeaders, seedFixture } from "./helpers";

async function setup() {
	const { workspace, user, token } = await seedFixture({ role: "owner" });
	const ctx: ServiceCtx = {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role: "owner",
	};
	const created = (await createWikiPage(ctx, { title: "Doc", content: "v0" })) as { slug: string };
	// One edit so the page has a revision pointer.
	await updateWikiPage(ctx, created.slug, { content: "v1" });
	return { ctx, slug: created.slug, token, wsSlug: workspace.slug };
}

// Run `concurrent` just before the next db.batch — i.e. after the service has read the
// page but before its write lands, which is exactly the race window.
function interleaveBeforeNextBatch(times: number, concurrent: () => Promise<void>) {
	const orig = env.DB.batch.bind(env.DB);
	let remaining = times;
	vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => {
		if (remaining > 0) {
			remaining--;
			await concurrent();
		}
		return orig(stmts);
	});
}

async function contentOf(ctx: ServiceCtx, slug: string): Promise<string> {
	return ((await getWikiPage(ctx, slug)) as { content: string }).content;
}

afterEach(() => vi.restoreAllMocks());

describe("PROJ-809: get_wiki_page returns the revision it read", () => {
	it("a stale reader using the GET's revisionId gets a 409, not a silent overwrite", async () => {
		const { ctx, slug } = await setup();
		const readByA = (await getWikiPage(ctx, slug)) as { revisionId: string | null };
		expect(typeof readByA.revisionId).toBe("string");

		await updateWikiPage(ctx, slug, { content: "B's edit", baseRevisionId: readByA.revisionId });

		// The old way: A fetches the revision list AFTER B's save and gets B's pointer.
		const listed = (await listWikiRevisions(ctx, slug)) as Array<{ id: string }>;
		expect(listed[0].id).not.toBe(readByA.revisionId);

		await expect(
			updateWikiPage(ctx, slug, { content: "A's stale copy", baseRevisionId: readByA.revisionId })
		).rejects.toBeInstanceOf(ConflictError);
		expect(await contentOf(ctx, slug)).toBe("B's edit");
	});

	it("REST GET carries revisionId in the body and as the ETag", async () => {
		const { slug, token, wsSlug } = await setup();
		const res = await SELF.fetch(`http://localhost/api/wiki/${slug}`, {
			headers: authHeaders(token, wsSlug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { revisionId: string };
		expect(res.headers.get("ETag")).toBe(`"${body.revisionId}"`);
	});
});

describe("PROJ-810: guarded writes", () => {
	it("update_wiki_page without a base: a write landing between read and write → 409", async () => {
		const { ctx, slug } = await setup();
		interleaveBeforeNextBatch(1, async () => {
			await env.DB.prepare("UPDATE wiki_pages SET content = 'concurrent' WHERE slug = ?")
				.bind(slug)
				.run();
		});
		await expect(updateWikiPage(ctx, slug, { content: "mine" })).rejects.toBeInstanceOf(
			ConflictError
		);
		expect(await contentOf(ctx, slug)).toBe("concurrent");
	});

	it("set_frontmatter racing an update: the update isn't reverted", async () => {
		const { ctx, slug } = await setup();
		const { revisionId } = (await getWikiPage(ctx, slug)) as { revisionId: string | null };
		interleaveBeforeNextBatch(1, async () => {
			await env.DB.prepare("UPDATE wiki_pages SET content = 'concurrent body' WHERE slug = ?")
				.bind(slug)
				.run();
		});
		await patchWikiPage(ctx, slug, {
			op: "set_frontmatter",
			values: { status: "draft" },
			baseRevisionId: revisionId,
		});
		const content = await contentOf(ctx, slug);
		expect(content).toContain("concurrent body");
		expect(content).toContain("status: draft");
	});

	it("append_to_page retries and both writes survive", async () => {
		const { ctx, slug } = await setup();
		const { revisionId } = (await getWikiPage(ctx, slug)) as { revisionId: string | null };
		interleaveBeforeNextBatch(1, async () => {
			await env.DB.prepare("UPDATE wiki_pages SET content = 'v1\nfrom B' WHERE slug = ?")
				.bind(slug)
				.run();
		});
		await patchWikiPage(ctx, slug, {
			op: "append_to_page",
			text: "from A",
			baseRevisionId: revisionId,
		});
		const content = await contentOf(ctx, slug);
		expect(content).toContain("from B");
		expect(content).toContain("from A");
	});

	it("append gives up with a 409 after bounded retries", async () => {
		const { ctx, slug } = await setup();
		const { revisionId } = (await getWikiPage(ctx, slug)) as { revisionId: string | null };
		let n = 0;
		interleaveBeforeNextBatch(10, async () => {
			n++;
			await env.DB.prepare("UPDATE wiki_pages SET content = ? WHERE slug = ?")
				.bind(`churn ${n}`, slug)
				.run();
		});
		await expect(
			patchWikiPage(ctx, slug, { op: "append_to_page", text: "x", baseRevisionId: revisionId })
		).rejects.toBeInstanceOf(ConflictError);
		expect(n).toBe(3);
	});
});

describe("PROJ-919: metadata-only writes are guarded too", () => {
	it("two interleaved title-only updates → one 409, the first title survives", async () => {
		const { ctx, slug } = await setup();
		interleaveBeforeNextBatch(1, async () => {
			await updateWikiPage(ctx, slug, { title: "B's title" });
		});
		await expect(updateWikiPage(ctx, slug, { title: "A's title" })).rejects.toBeInstanceOf(
			ConflictError
		);
		expect(((await getWikiPage(ctx, slug)) as { title: string }).title).toBe("B's title");
	});

	it("a move racing a rename → 409 for the move; the rename isn't reverted", async () => {
		const { ctx, slug } = await setup();
		const parent = (await createWikiPage(ctx, { title: "Parent", content: "p" })) as {
			id: string;
		};
		interleaveBeforeNextBatch(1, async () => {
			await updateWikiPage(ctx, slug, { title: "Renamed" });
		});
		await expect(updateWikiPage(ctx, slug, { parentId: parent.id })).rejects.toBeInstanceOf(
			ConflictError
		);
		const page = (await getWikiPage(ctx, slug)) as { title: string; parent_id: string | null };
		expect(page.title).toBe("Renamed");
		expect(page.parent_id).toBeNull();
	});

	it("a content write racing a title-only write → 409 instead of reverting the title", async () => {
		const { ctx, slug } = await setup();
		interleaveBeforeNextBatch(1, async () => {
			await updateWikiPage(ctx, slug, { title: "Concurrent title" });
		});
		await expect(
			updateWikiPage(ctx, slug, { title: "Doc", content: "mine" })
		).rejects.toBeInstanceOf(ConflictError);
		const page = (await getWikiPage(ctx, slug)) as { title: string; content: string };
		expect(page.title).toBe("Concurrent title");
		expect(page.content).toBe("v1");
	});

	it("sequential metadata-only updates with no race still succeed", async () => {
		const { ctx, slug } = await setup();
		await updateWikiPage(ctx, slug, { title: "One" });
		await updateWikiPage(ctx, slug, { title: "Two" });
		expect(((await getWikiPage(ctx, slug)) as { title: string }).title).toBe("Two");
	});

	it("every write bumps the page version", async () => {
		const { ctx, slug } = await setup();
		const { id } = (await getWikiPage(ctx, slug)) as { id: string };
		const versionOf = async () =>
			(
				await env.DB.prepare("SELECT version FROM wiki_pages WHERE id = ?")
					.bind(id)
					.first<{ version: number }>()
			)?.version as number;
		const before = await versionOf();
		await updateWikiPage(ctx, slug, { title: "Bumped" });
		expect(await versionOf()).toBe(before + 1);
		const { revisionId } = (await getWikiPage(ctx, slug)) as { revisionId: string | null };
		await patchWikiPage(ctx, slug, {
			op: "append_to_page",
			text: "more",
			baseRevisionId: revisionId,
		});
		expect(await versionOf()).toBe(before + 2);
	});
});
