import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceCtx } from "../services/types";
import { createWikiPage, patchWikiPage, updateWikiPage } from "../services/wiki";
import { seedFixture, seedMember, seedUser } from "./helpers";

function trackD1RoundTrips() {
	let count = 0;
	const origPrepare = env.DB.prepare.bind(env.DB);
	const origBatch = env.DB.batch.bind(env.DB);
	const EXEC_METHODS = new Set(["run", "all", "get", "first", "raw"]);

	const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...args: unknown[]) =>
						wrapStmt((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
				}
				if (typeof prop === "string" && EXEC_METHODS.has(prop)) {
					return (...args: unknown[]) => {
						count++;
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			},
		});

	vi.spyOn(env.DB, "prepare").mockImplementation(
		(q: string) => wrapStmt(origPrepare(q)) as D1PreparedStatement
	);
	vi.spyOn(env.DB, "batch").mockImplementation((stmts: D1PreparedStatement[]) => {
		count++;
		return origBatch(stmts);
	});

	return { count: () => count };
}

function failWatcherQueries() {
	const origPrepare = env.DB.prepare.bind(env.DB);
	vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
		if (q.includes("FROM wiki_watchers")) throw new Error("watcher lookup exploded");
		return origPrepare(q);
	});
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(depth: number) {
	const { workspace, user } = await seedFixture({ role: "owner" });
	const watcher = await seedUser(`w-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(workspace.id, watcher.id, "owner");
	const pending: Promise<unknown>[] = [];
	const ctx: ServiceCtx = {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role: "owner",
		waitUntil: (p) => {
			pending.push(p);
		},
	};
	let parentId: string | undefined;
	const ids: string[] = [];
	for (let i = 0; i <= depth; i++) {
		const page = await createWikiPage(ctx, {
			title: `Page ${i}`,
			content: "# H\n\nbody",
			parentId,
		});
		ids.push(page.id);
		parentId = page.id;
	}
	await env.DB.prepare(
		"INSERT INTO wiki_watchers (id, workspace_id, user_id, page_id, subtree, created_at) VALUES (?, ?, ?, ?, 1, 0)"
	)
		.bind(crypto.randomUUID(), workspace.id, watcher.id, ids[0])
		.run();
	pending.length = 0;
	return { ctx, pending, ids, watcherId: watcher.id, workspaceId: workspace.id };
}

async function notificationCount(workspaceId: string, userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM wiki_notifications WHERE workspace_id = ? AND user_id = ?"
	)
		.bind(workspaceId, userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function activityCount(workspaceId: string, pageId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM activity WHERE workspace_id = ? AND entity_id = ? AND action = 'updated'"
	)
		.bind(workspaceId, pageId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PROJ-1019: notification is off the response path", () => {
	it("update_wiki_page and patch_wiki_page succeed when the notifier fails", async () => {
		const { ctx, pending, ids, workspaceId } = await setup(1);
		const leaf = ids[1];
		const noWaitUntil: ServiceCtx = { ...ctx, waitUntil: undefined };
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		failWatcherQueries();

		await expect(updateWikiPage(noWaitUntil, leaf, { content: "# H\n\nedited" })).resolves.toEqual(
			expect.objectContaining({ ok: true })
		);
		await expect(
			patchWikiPage(noWaitUntil, leaf, { op: "append_to_page", text: "more" })
		).resolves.toEqual(expect.objectContaining({ ok: true }));
		await expect(updateWikiPage(ctx, leaf, { content: "# H\n\nvia waituntil" })).resolves.toEqual(
			expect.objectContaining({ ok: true })
		);
		await Promise.all(pending);

		expect(errSpy).toHaveBeenCalledTimes(3);
		expect(await activityCount(workspaceId, leaf)).toBe(3);
	});

	it("notifies subtree watchers through waitUntil, not before the write returns", async () => {
		const { ctx, pending, ids, watcherId, workspaceId } = await setup(2);
		await updateWikiPage(ctx, ids[2], { content: "# H\n\nchanged" });
		expect(pending).toHaveLength(1);
		await Promise.all(pending);
		expect(await notificationCount(workspaceId, watcherId)).toBe(1);
	});

	it("without waitUntil the notification is awaited before returning", async () => {
		const { ctx, ids, watcherId, workspaceId } = await setup(2);
		await patchWikiPage({ ...ctx, waitUntil: undefined }, ids[2], {
			op: "append_to_page",
			text: "x",
		});
		expect(await notificationCount(workspaceId, watcherId)).toBe(1);
	});

	it("never notifies watchers from another workspace", async () => {
		const { ctx, ids, watcherId, workspaceId } = await setup(1);
		const other = await seedFixture({ role: "owner" });
		await env.DB.prepare(
			"INSERT INTO wiki_watchers (id, workspace_id, user_id, page_id, subtree, created_at) VALUES (?, ?, ?, ?, 1, 0)"
		)
			.bind(crypto.randomUUID(), other.workspace.id, other.user.id, ids[0])
			.run();
		await updateWikiPage({ ...ctx, waitUntil: undefined }, ids[1], { content: "# H\n\nz" });
		expect(await notificationCount(workspaceId, watcherId)).toBe(1);
		expect(await notificationCount(other.workspace.id, other.user.id)).toBe(0);
	});
});

describe("PROJ-1019: round trips", () => {
	async function measure(run: (s: Setup) => Promise<unknown>, depth: number) {
		const s = await setup(depth);
		await updateWikiPage({ ...s.ctx, waitUntil: undefined }, s.ids[depth], {
			content: "# H\n\nwarm",
		});
		const t = trackD1RoundTrips();
		await run(s);
		const n = t.count();
		vi.restoreAllMocks();
		return n;
	}

	it("update_wiki_page round trips do not grow with ancestor depth", async () => {
		const run = (s: Setup) =>
			updateWikiPage({ ...s.ctx, waitUntil: undefined }, s.ids[s.ids.length - 1], {
				content: "# H\n\nround trip",
			});
		const shallow = await measure(run, 1);
		const deep = await measure(run, 4);
		console.log(`update_wiki_page round trips shallow=${shallow} deep=${deep}`);
		expect(deep).toBe(shallow);
		expect(shallow).toBeLessThanOrEqual(8);
	});

	it("patch_wiki_page round trips do not grow with ancestor depth", async () => {
		const run = (s: Setup) =>
			patchWikiPage({ ...s.ctx, waitUntil: undefined }, s.ids[s.ids.length - 1], {
				op: "append_to_page",
				text: "round trip",
			});
		const shallow = await measure(run, 1);
		const deep = await measure(run, 4);
		console.log(`patch_wiki_page round trips shallow=${shallow} deep=${deep}`);
		expect(deep).toBe(shallow);
		expect(shallow).toBeLessThanOrEqual(8);
	});
});
