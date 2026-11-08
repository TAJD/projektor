import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "../services/errors";
import { updateIssue } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedIssue, seedProjectFixture, toolError } from "./helpers";

describe("PROJ-1023: appendBody and bodyEdits on update_issue", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let ctx: ServiceCtx;
	let issueId: string;
	let ref: string;

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "1000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});
	afterEach(() => vi.restoreAllMocks());

	beforeEach(async () => {
		const f = await seedProjectFixture();
		({ token, slug, workspaceId } = f);
		ctx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId,
			userId: f.userId,
			role: "owner",
		};
		const issue = await seedIssue(workspaceId, f.projectId, f.userId, { title: "Body" });
		issueId = issue.id;
		ref = `PROJ-${issue.number}`;
		await setBody("## Context\nOld text.\n\n## Criteria\n- [ ] one\n- [ ] two\n");
	});

	async function setBody(body: string) {
		await env.DB.prepare("UPDATE issues SET body = ? WHERE id = ?").bind(body, issueId).run();
	}

	async function body(): Promise<string> {
		const row = await env.DB.prepare("SELECT body FROM issues WHERE id = ?")
			.bind(issueId)
			.first<{ body: string }>();
		return row?.body ?? "";
	}

	async function ftsMatches(term: string): Promise<number> {
		const row = await env.DB.prepare(
			"SELECT count(*) AS n FROM issues_fts WHERE issues_fts MATCH ? AND issue_id = ?"
		)
			.bind(term, issueId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async function call(args: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update_issue", arguments: { id: ref, ...args } },
			}),
		});
		return toolError(await res.json());
	}

	it("appendBody adds a paragraph after the current body", async () => {
		expect(await call({ appendBody: "Update: shipped." })).toBeUndefined();
		expect(await body()).toBe(
			"## Context\nOld text.\n\n## Criteria\n- [ ] one\n- [ ] two\n\nUpdate: shipped."
		);
		expect(await ftsMatches("shipped")).toBe(1);
	});

	it("appendBody on an empty body sets it", async () => {
		await setBody("");
		expect(await call({ appendBody: "First words." })).toBeUndefined();
		expect(await body()).toBe("First words.");
	});

	it("bodyEdits apply in order, then appendBody", async () => {
		const err = await call({
			bodyEdits: [
				{ find: "- [ ] one", replace: "- [x] one" },
				{ find: "Old text.", replace: "New text." },
			],
			appendBody: "Done.",
		});
		expect(err).toBeUndefined();
		expect(await body()).toBe(
			"## Context\nNew text.\n\n## Criteria\n- [x] one\n- [ ] two\n\nDone."
		);
	});

	it("an edit that matches twice or not at all names the edit and count, and writes nothing", async () => {
		const before = await body();
		const twice = await call({
			bodyEdits: [
				{ find: "Old", replace: "Older" },
				{ find: "- [ ]", replace: "- [x]" },
			],
			title: "Renamed",
		});
		expect(twice?.code).toBe("validation");
		expect(twice?.fields?.bodyEdits?.[0]).toContain("bodyEdits[1].find matches 2 times");

		const none = await call({ bodyEdits: [{ find: "absent", replace: "x" }] });
		expect(none?.fields?.bodyEdits?.[0]).toContain("bodyEdits[0].find matches 0 times");

		await setBody("aaa");
		const overlapping = await call({ bodyEdits: [{ find: "aa", replace: "b" }] });
		expect(overlapping?.fields?.bodyEdits?.[0]).toContain("matches 2 times");
		await setBody(before);

		expect(await body()).toBe(before);
		const title = await env.DB.prepare("SELECT title FROM issues WHERE id = ?")
			.bind(issueId)
			.first<{ title: string }>();
		expect(title?.title).toBe("Body");
	});

	it("body cannot be combined with appendBody or bodyEdits", async () => {
		const err = await call({ body: "whole", appendBody: "more" });
		expect(err?.code).toBe("validation");
		expect(err?.fields?.body?.[0]).toContain("cannot be combined");
		await expect(
			updateIssue(ctx, issueId, { body: "x", bodyEdits: [{ find: "Old", replace: "New" }] })
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("an edited body over the length limit is rejected", async () => {
		const err = await updateIssue(ctx, issueId, { appendBody: "x".repeat(50000) }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).issues.fieldErrors.appendBody?.[0]).toContain("limit is 50000");
	});

	it("REST PATCH accepts the same fields", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${ref}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ bodyEdits: [{ find: "- [ ] two", replace: "- [x] two" }] }),
		});
		expect(res.status).toBe(200);
		expect(await body()).toContain("- [x] two");

		const bad = await SELF.fetch(`http://localhost/api/issues/${ref}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ bodyEdits: [{ find: "nope", replace: "x" }] }),
		});
		expect(bad.status).toBe(400);
	});

	it("a body change landing between the read and the write is not overwritten", async () => {
		const orig = env.DB.batch.bind(env.DB);
		let raced = false;
		vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => {
			if (!raced) {
				raced = true;
				await setBody("## Context\nOld text.\nSomeone else's line.\n");
			}
			return orig(stmts);
		});
		await expect(
			updateIssue(ctx, issueId, { bodyEdits: [{ find: "Old text.", replace: "New text." }] })
		).rejects.toBeInstanceOf(ConflictError);
		expect(await body()).toBe("## Context\nOld text.\nSomeone else's line.\n");
	});
});
