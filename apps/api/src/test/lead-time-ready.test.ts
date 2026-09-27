import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0062 from "../../../../packages/db/migrations/0062_repair_zero_lead_time.sql?raw";
import { authHeaders, seedProjectFixture } from "./helpers";

// PROJ-921: lead time (ready -> done) came out as a 0s median because an issue moved
// straight from backlog to done in one update got ready_at = done_at. ready_at is now
// stamped only when an issue actually enters a ready status (including on create), and
// issues that never did are excluded from lead time and counted separately.
describe("PROJ-921: ready_at and lead time", () => {
	let token: string;
	let slug: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function create(status: string): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: `t-${status}`, status }),
		});
		expect(res.status).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	async function patch(id: string, status: string) {
		const res = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ status }),
		});
		expect(res.status).toBe(200);
	}

	async function stamps(id: string) {
		return env.DB.prepare("SELECT ready_at, done_at FROM issues WHERE id = ?")
			.bind(id)
			.first<{ ready_at: number | null; done_at: number | null }>();
	}

	it("an issue created in todo is ready from creation", async () => {
		const id = await create("todo");
		expect((await stamps(id))?.ready_at).not.toBeNull();
	});

	it("backlog -> done in one update never passed through ready: no ready_at", async () => {
		const id = await create("backlog");
		await patch(id, "done");
		const s = await stamps(id);
		expect(s?.done_at).not.toBeNull();
		expect(s?.ready_at).toBeNull();
	});

	it("backlog -> todo and backlog -> in_progress (fast-tracked, PROJ-252) both stamp it", async () => {
		const readied = await create("backlog");
		await patch(readied, "todo");
		expect((await stamps(readied))?.ready_at).not.toBeNull();

		const fastTracked = await create("backlog");
		await patch(fastTracked, "in_progress");
		expect((await stamps(fastTracked))?.ready_at).not.toBeNull();
	});

	it("an issue created already done never was ready", async () => {
		const id = await create("done");
		expect((await stamps(id))?.ready_at).toBeNull();
	});

	it("flow metrics exclude skipped-ready issues from lead time and report how many", async () => {
		const skipped = await create("backlog");
		await patch(skipped, "done");
		const normal = await create("todo");
		await patch(normal, "done");

		const res = await SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const m = (await res.json()) as { leadTime: { count: number }; leadTimeExcluded: number };
		expect(m.leadTime.count).toBe(1);
		expect(m.leadTimeExcluded).toBe(1);
	});
});

describe("PROJ-921: migration 0062 clears zero lead times", () => {
	it("nulls ready_at only where it equals done_at", async () => {
		const { workspaceId, projectId, userId } = await seedProjectFixture({ role: "owner" });
		const rows = [
			{ id: crypto.randomUUID(), ready: 100, done: 100 }, // skipped ready
			{ id: crypto.randomUUID(), ready: 50, done: 100 }, // real lead time
			{ id: crypto.randomUUID(), ready: 50, done: null }, // still open
		];
		let n = 1000;
		for (const r of rows) {
			await env.DB.prepare(
				`INSERT INTO issues (id, workspace_id, project_id, number, title, body, status, created_by_id, created_at, updated_at, ready_at, done_at)
				 VALUES (?, ?, ?, ?, 't', '', 'todo', ?, 0, 0, ?, ?)`
			)
				.bind(r.id, workspaceId, projectId, n++, userId, r.ready, r.done)
				.run();
		}
		const repair = m0062
			.replace(/--[^\n]*/g, "")
			.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("UPDATE"));
		await env.DB.prepare(repair as string).run();

		const after = await Promise.all(
			rows.map((r) =>
				env.DB.prepare("SELECT ready_at FROM issues WHERE id = ?")
					.bind(r.id)
					.first<{ ready_at: number | null }>()
			)
		);
		expect(after.map((a) => a?.ready_at)).toEqual([null, 50, 50]);
	});
});
