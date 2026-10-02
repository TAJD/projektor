import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture, seedTaskType, toolError } from "./helpers";

// PROJ-962: closing the last open child of an epic either closes the epic
// (project.epicAutoClose) or returns parentReadyToClose:{ref}.

describe("PROJ-962: epic closing when the last child is closed", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let epicId: string;
	let epicRef: string;
	let kids: Array<{ id: string; ref: string }>;

	async function call(name: string, args: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const json = await res.json();
		const err = toolError(json);
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		return { err, data: (text && !err ? JSON.parse(text) : undefined) as any };
	}

	const report = {
		summary: "done",
		verification: "https://github.com/acme/repo/commit/abcdef1234567",
	};
	const close = (ref: string, status: "done" | "cancelled" = "done") =>
		call("update_issue", { id: ref, status, completionReport: report });

	async function epicStatus() {
		const row = await env.DB.prepare("SELECT status FROM issues WHERE id = ?")
			.bind(epicId)
			.first<{ status: string }>();
		return row?.status;
	}

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
		const epicType = await seedTaskType(workspaceId, { key: "epic" });
		const epic = await seedIssue(workspaceId, projectId, userId, { title: "Epic" });
		await env.DB.prepare("UPDATE issues SET type_id = ? WHERE id = ?")
			.bind(epicType.id, epic.id)
			.run();
		epicId = epic.id;
		epicRef = `PROJ-${epic.number}`;
		kids = [];
		for (const title of ["a", "b", "c"]) {
			const k = await seedIssue(workspaceId, projectId, userId, { title, parentId: epicId });
			kids.push({ id: k.id, ref: `PROJ-${k.number}` });
		}
	});

	describe("default (hint) mode", () => {
		it("only the last close returns parentReadyToClose", async () => {
			const first = await close(kids[0].ref);
			const second = await close(kids[1].ref);
			expect(first.data.parentReadyToClose).toBeUndefined();
			expect(second.data.parentReadyToClose).toBeUndefined();
			const last = await close(kids[2].ref);
			expect(last.err).toBeUndefined();
			expect(last.data.parentReadyToClose).toEqual({ ref: epicRef });
			expect(await epicStatus()).not.toBe("done");
		});

		it("cancelled children count as closed", async () => {
			await close(kids[0].ref, "cancelled");
			await close(kids[1].ref, "done");
			const last = await close(kids[2].ref, "cancelled");
			expect(last.data.parentReadyToClose).toEqual({ ref: epicRef });
		});

		it("an all-cancelled epic is still reported ready", async () => {
			await close(kids[0].ref, "cancelled");
			await close(kids[1].ref, "cancelled");
			const last = await close(kids[2].ref, "cancelled");
			expect(last.data.parentReadyToClose).toEqual({ ref: epicRef });
		});

		it("an open child elsewhere in the epic suppresses the hint", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			await seedIssue(workspaceId, projectId, userId, { title: "d", parentId: epicId });
			const third = await close(kids[2].ref);
			expect(third.data.parentReadyToClose).toBeUndefined();
		});

		it("a non-closing update of the last child gives no hint", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			const { data } = await call("update_issue", { id: kids[2].ref, title: "renamed" });
			expect(data.parentReadyToClose).toBeUndefined();
		});

		it("no hint once the epic itself is already done", async () => {
			await env.DB.prepare(
				"UPDATE issues SET status = 'done', status_category = 'done' WHERE id = ?"
			)
				.bind(epicId)
				.run();
			await close(kids[0].ref);
			await close(kids[1].ref);
			const last = await close(kids[2].ref);
			expect(last.data.parentReadyToClose).toBeUndefined();
		});

		it("a parent that is not an epic gets no hint", async () => {
			await env.DB.prepare("UPDATE issues SET type_id = NULL WHERE id = ?").bind(epicId).run();
			await close(kids[0].ref);
			await close(kids[1].ref);
			const last = await close(kids[2].ref);
			expect(last.data.parentReadyToClose).toBeUndefined();
		});

		it("a remainder follow-up keeps the epic from being ready", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			const last = await call("update_issue", {
				id: kids[2].ref,
				status: "done",
				completionReport: { ...report, remainder: "still to do" },
			});
			expect(last.data.followUp).toBeDefined();
			expect(last.data.parentReadyToClose).toBeUndefined();
		});

		it("finish_work passes the hint through", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			const start = await call("start_work", { issue: kids[2].ref, name: "w" });
			const { err, data } = await call("finish_work", {
				sessionId: start.data.sessionId,
				issue: kids[2].ref,
				status: "done",
				completionReport: report,
			});
			expect(err).toBeUndefined();
			expect(data.parentReadyToClose).toEqual({ ref: epicRef });
		});

		it("REST PATCH returns the hint too (parity)", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			const res = await SELF.fetch(`http://localhost/api/issues/${kids[2].id}`, {
				method: "PATCH",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ status: "done", completionReport: report }),
			});
			expect(((await res.json()) as { parentReadyToClose?: unknown }).parentReadyToClose).toEqual({
				ref: epicRef,
			});
		});
	});

	describe("epicAutoClose mode", () => {
		beforeEach(async () => {
			const { err } = await call("update_project", { id: projectId, epicAutoClose: true });
			expect(err).toBeUndefined();
		});

		it("closes the epic on the last child and reports parentClosed", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			expect(await epicStatus()).not.toBe("done");
			const last = await close(kids[2].ref);
			expect(last.err).toBeUndefined();
			expect(last.data.parentClosed).toEqual({ ref: epicRef });
			expect(last.data.parentReadyToClose).toBeUndefined();
			expect(await epicStatus()).toBe("done");
		});

		it("cancelled children count as closed", async () => {
			await close(kids[0].ref, "cancelled");
			await close(kids[1].ref, "cancelled");
			const last = await close(kids[2].ref, "done");
			expect(last.data.parentClosed).toEqual({ ref: epicRef });
			expect(await epicStatus()).toBe("done");
		});

		it("does not close while a follow-up remains open", async () => {
			await close(kids[0].ref);
			await close(kids[1].ref);
			const last = await call("update_issue", {
				id: kids[2].ref,
				status: "done",
				completionReport: { ...report, remainder: "more" },
			});
			expect(last.data.parentClosed).toBeUndefined();
			expect(await epicStatus()).not.toBe("done");
		});

		it("can be switched back to hint mode", async () => {
			await call("update_project", { id: projectId, epicAutoClose: false });
			await close(kids[0].ref);
			await close(kids[1].ref);
			const last = await close(kids[2].ref);
			expect(last.data.parentReadyToClose).toEqual({ ref: epicRef });
			expect(await epicStatus()).not.toBe("done");
		});
	});
});
