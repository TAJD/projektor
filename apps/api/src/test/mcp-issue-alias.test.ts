import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedComment, seedIssue, seedProjectFixture, toolError } from "./helpers";

const SPELLINGS = ["id", "issueId", "ref", "issue", "issue_id"] as const;

describe("PROJ-998/PROJ-1007: MCP argument aliases", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let issueId: string;
	let issueRef: string;
	let commentId: string;
	let sessionId: string;

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

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
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		return { err: toolError(json), data: text ? JSON.parse(text) : undefined };
	}

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "admin" }));
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Alias" });
		issueId = issue.id;
		issueRef = `PROJ-${issue.number}`;
		commentId = (await seedComment(issueId, userId)).id;
		sessionId = (await call("register_agent", { name: "alias-agent" })).data.id;
	});

	const tools: Array<{
		tool: string;
		canonical: string;
		extra: () => Record<string, unknown> | Promise<Record<string, unknown>>;
	}> = [
		{ tool: "get_issue", canonical: "id", extra: () => ({}) },
		{ tool: "update_issue", canonical: "id", extra: () => ({ title: "Renamed" }) },
		{ tool: "delete_issue", canonical: "id", extra: () => ({}) },
		{ tool: "list_comments", canonical: "issueId", extra: () => ({}) },
		{ tool: "add_comment", canonical: "issueId", extra: () => ({ body: "hi" }) },
		{
			tool: "update_comment",
			canonical: "issueId",
			extra: () => ({ commentId, body: "edited" }),
		},
		{ tool: "delete_comment", canonical: "issueId", extra: () => ({ commentId }) },
		{ tool: "claim_issue", canonical: "issueId", extra: () => ({ agentId: sessionId }) },
		{
			tool: "release_issue",
			canonical: "issueId",
			extra: async () => {
				await call("claim_issue", { issueId, agentId: sessionId });
				return { agentId: sessionId };
			},
		},
		{ tool: "list_issue_links", canonical: "issueId", extra: () => ({}) },
		{
			tool: "claim_files",
			canonical: "issueId",
			extra: () => ({ agentId: sessionId, paths: ["src/a.ts"] }),
		},
		{ tool: "start_work", canonical: "issue", extra: () => ({ name: "alias-start" }) },
		{
			tool: "finish_work",
			canonical: "issue",
			extra: async () => {
				const started = await call("start_work", { issue: issueId, name: "alias-finish" });
				return { sessionId: started.data.sessionId };
			},
		},
	];

	for (const { tool, canonical, extra } of tools) {
		for (const spelling of SPELLINGS) {
			it(`${tool}: accepts the issue as ${spelling}`, async () => {
				const value = spelling === "ref" ? issueRef : issueId;
				const res = await call(tool, { ...(await extra()), [spelling]: value });
				expect(res.err).toBeUndefined();
			});
		}

		it(`${tool}: rejects two spellings naming different issues`, async () => {
			const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
			const res = await call(tool, {
				...(await extra()),
				[canonical]: issueId,
				ref: `PROJ-${other.number}`,
			});
			expect(res.err?.code).toBe("validation");
			expect(res.err?.fields?.[canonical]?.[0]).toContain("differ");
		});
	}

	it("accepts several spellings that carry the same value", async () => {
		const res = await call("update_issue", {
			id: issueId,
			issueId,
			issue_id: issueId,
			title: "Same",
		});
		expect(res.err).toBeUndefined();
	});

	it("register_agent: links the session to the issue under any spelling", async () => {
		for (const spelling of SPELLINGS) {
			const value = spelling === "ref" ? issueRef : issueId;
			const res = await call("register_agent", { name: `reg-${spelling}`, [spelling]: value });
			expect(res.err).toBeUndefined();
			expect(res.data.issueId).toBe(issueId);
		}
	});

	it("release_files: scopes the release to the issue under any spelling", async () => {
		const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
		await call("claim_files", { issueId, agentId: sessionId, paths: ["src/a.ts"] });
		for (const spelling of SPELLINGS) {
			const value = spelling === "ref" ? `PROJ-${other.number}` : other.id;
			const res = await call("release_files", { paths: ["src/a.ts"], [spelling]: value });
			expect(res.err).toBeUndefined();
			expect(res.data.released).toBe(0);
		}
	});

	describe("synonyms and snake_case keys", () => {
		it("create_issue: description and project_id map to body and projectId", async () => {
			const res = await call("create_issue", {
				project_id: projectId,
				title: "Synonym",
				description: "the body",
			});
			expect(res.err).toBeUndefined();
			const got = await call("get_issue", { id: res.data.id });
			expect(got.data.body).toBe("the body");
		});

		it("update_issue: ref and description map to id and body", async () => {
			const res = await call("update_issue", { ref: issueRef, description: "new body" });
			expect(res.err).toBeUndefined();
			const got = await call("get_issue", { id: issueId });
			expect(got.data.body).toBe("new body");
		});

		for (const synonym of ["content", "text", "message"]) {
			it(`post_message: ${synonym} maps to body`, async () => {
				const res = await call("post_message", { scope: "workspace", [synonym]: "hello" });
				expect(res.err).toBeUndefined();
				const listed = await call("list_messages", { scope: "workspace" });
				expect(listed.data.items.map((m: { body: string }) => m.body)).toEqual(["hello"]);
			});
		}

		it("add_comment and list_comments: issue_id, issue and content map to issueId and body", async () => {
			const added = await call("add_comment", { issue_id: issueRef, content: "via synonym" });
			expect(added.err).toBeUndefined();
			const listed = await call("list_comments", { issue: issueRef });
			expect(listed.err).toBeUndefined();
			expect(JSON.stringify(listed.data)).toContain("via synonym");
		});

		it("release_files: files maps to paths", async () => {
			await call("claim_files", { issueId, agentId: sessionId, paths: ["src/a.ts"] });
			const res = await call("release_files", { files: ["src/a.ts"] });
			expect(res.err).toBeUndefined();
			expect(res.data.released).toBe(1);
		});

		it("finish_work: snake_case keys map at every level, including inside a renamed object", async () => {
			const started = await call("start_work", { issue: issueId, name: "nested" });
			const res = await call("finish_work", {
				session_id: started.data.sessionId,
				issue: issueId,
				status: "in_review",
				completion_report: {
					summary: "s",
					verification: "v",
					pr_link: "https://github.com/o/r/pull/1",
				},
			});
			expect(res.err).toBeUndefined();
			const comments = await call("list_comments", { issueId });
			expect(JSON.stringify(comments.data)).toContain("https://github.com/o/r/pull/1");
		});

		it("create_project: a declared description is kept, not mapped to body", async () => {
			const res = await call("create_project", {
				name: "Synonyms",
				key: "SYN",
				description: "kept",
			});
			expect(res.err).toBeUndefined();
			const got = await call("get_project", { id: res.data.id });
			expect(got.data.description).toBe("kept");
		});

		it("names a renamed argument in errors as it was sent", async () => {
			const created = await call("create_issue", {
				project_id: projectId,
				title: "x",
				description: 5,
			});
			expect(created.err?.code).toBe("validation");
			expect(Object.keys(created.err?.fields ?? {})).toEqual(["description"]);
			expect(created.err?.fields?.description?.[0]).toMatch(/must be string/);
			const updated = await call("update_issue", { ref: 42 });
			expect(Object.keys(updated.err?.fields ?? {})).toEqual(["ref"]);
		});

		it("names errors inside a renamed object or array by the sent path", async () => {
			const report = await call("update_issue", {
				id: issueId,
				status: "in_review",
				completion_report: { summary: "", verification: "v", pr_lnk: "x" },
			});
			expect(report.err?.fields).toEqual({
				"completion_report.summary": ["must be at least 1 characters"],
				"completion_report.pr_lnk": ['Unknown argument "pr_lnk"; did you mean "prLink"?'],
			});
			const files = await call("release_files", { files: [5] });
			expect(Object.keys(files.err?.fields ?? {})).toEqual(["files[0]"]);
		});

		it("rejects a synonym whose value differs from the declared key", async () => {
			const res = await call("create_issue", {
				projectId,
				title: "x",
				body: "a",
				description: "b",
			});
			expect(res.err?.code).toBe("validation");
			expect(res.err?.fields?.body?.[0]).toContain("differ");
		});

		it("REST stays strict: POST /api/issues rejects description", async () => {
			const res = await SELF.fetch("http://localhost/api/issues", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ projectId, title: "REST", description: "nope" }),
			});
			expect(res.status).toBe(400);
		});
	});
});
