// PROJ-892: windowed reads — bodyChars previews on lists, get_wiki_page maxChars/cursor/
// section/outline, and get_issue's long-body cursor.

import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outlineOf, sectionOf, windowText } from "../mcp/windowing";
import { seedProjectFixture } from "./helpers";

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

describe("PROJ-892: windowing (unit)", () => {
	it("never splits a surrogate pair at the window edge, and the cursor continues losslessly", () => {
		const text = `ab${"😀".repeat(5)}cd`; // 😀 is two UTF-16 units
		const first = windowText(text, { max: 3 }); // would land mid-pair
		expect(first.text).toBe("ab");
		expect(first.next).toBe("2");
		let out = first.text;
		let cursor = first.next;
		while (cursor) {
			const w = windowText(text, { max: 3, cursor });
			out += w.text;
			cursor = w.next;
		}
		expect(out).toBe(text);
		expect(first.totalChars).toBe(text.length);
	});

	it("a window smaller than one code point still makes progress (max:1 on an emoji)", () => {
		const text = "😀abc";
		const first = windowText(text, { max: 1 });
		expect(first.text).toBe("😀");
		expect(first.next).toBe("2");
		expect(windowText(text, { max: 1, cursor: first.next }).text).toBe("a");
	});

	it("rejects a bad cursor", () => {
		expect(() => windowText("abc", { max: 2, cursor: "x" })).toThrow();
		expect(() => windowText("abc", { max: 2, cursor: "99" })).toThrow();
	});

	it("outline skips code fences and frontmatter; sectionOf stops at the next same-or-higher heading", () => {
		const md =
			"---\ntitle: x\n# not a heading\n---\n# Top\nintro\n## A\na body\n```\n# fake\n```\n### A1\ndeep\n## B\nb body\n";
		expect(outlineOf(md)).toEqual(["# Top", "## A", "### A1", "## B"]);
		expect(sectionOf(md, "A")).toBe("## A\na body\n```\n# fake\n```\n### A1\ndeep");
		expect(sectionOf(md, "## b")).toBe("## B\nb body");
		expect(sectionOf(md, "nope")).toBeUndefined();
	});
});

describe("PROJ-892: MCP tools", () => {
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "1000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	let f: Awaited<ReturnType<typeof seedProjectFixture>>;
	beforeEach(async () => {
		f = await seedProjectFixture();
	});

	async function call(name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
		const res = await SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		return (await res.json()) as Rpc;
	}
	async function tool<T = Record<string, unknown>>(name: string, args = {}): Promise<T> {
		const body = await call(name, args);
		expect(body.result?.isError, JSON.stringify(body)).toBeUndefined();
		return JSON.parse(body.result?.content?.[0].text ?? "null") as T;
	}

	it("list_issues: bodyChars previews and flags truncation; default has no body", async () => {
		await tool("create_issue", {
			projectId: f.projectId,
			title: "Long",
			body: "z".repeat(3000),
		});
		await tool("create_issue", { projectId: f.projectId, title: "Short", body: "tiny" });

		const none = await tool<{ items: Array<Record<string, unknown>> }>("list_issues", {});
		expect(none.items.every((i) => !("body" in i))).toBe(true);

		const page = await tool<{ items: Array<Record<string, unknown>> }>("list_issues", {
			bodyChars: 100,
		});
		const long = page.items.find((i) => i.title === "Long");
		const short = page.items.find((i) => i.title === "Short");
		expect(String(long?.body)).toHaveLength(100);
		expect(long?.bodyTruncated).toBe(true);
		expect(short?.body).toBe("tiny");
		expect(short).not.toHaveProperty("bodyTruncated");
	});

	it("list_issues: bodyChars is validated (max 1000)", async () => {
		const res = await call("list_issues", { bodyChars: 5000 });
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content?.[0].text).toContain("bodyChars");
	});

	it("get_issue: a body over 16,000 chars is windowed and continues via cursor", async () => {
		const body = "abcdefghij".repeat(2000); // 20,000 chars
		const created = await tool<{ id: string }>("create_issue", {
			projectId: f.projectId,
			title: "Huge",
			body,
		});
		const first = await tool<{
			body: string;
			bodyTruncated?: boolean;
			bodyTotalChars: number;
			next?: string;
		}>("get_issue", { id: created.id });
		expect(first.body).toHaveLength(16_000);
		expect(first.bodyTruncated).toBe(true);
		expect(first.bodyTotalChars).toBe(20_000);
		const second = await tool<{ body: string; next?: string }>("get_issue", {
			id: created.id,
			cursor: first.next,
		});
		expect(second.next).toBeUndefined();
		expect(first.body + second.body).toBe(body);
	});

	it("get_issue: a short body is returned whole with no window fields", async () => {
		const created = await tool<{ id: string }>("create_issue", {
			projectId: f.projectId,
			title: "Small",
			body: "hello",
		});
		const got = await tool<Record<string, unknown>>("get_issue", { id: created.id });
		expect(got.body).toBe("hello");
		expect(got).not.toHaveProperty("next");
		expect(got).not.toHaveProperty("bodyTotalChars");
	});

	async function makeWiki(content: string): Promise<string> {
		const p = await tool<{ slug: string }>("create_wiki_page", { title: "Long Doc", content });
		return p.slug;
	}

	it("get_wiki_page: windows by maxChars with totalChars/outline, and the cursor reassembles the page", async () => {
		const content = `# Intro\n${"x".repeat(50)}\n## Details\n${"y".repeat(50)}\n`;
		const slug = await makeWiki(content);
		const first = await tool<{
			content: string;
			totalChars: number;
			outline: string[];
			next?: string;
			revisionId: string;
		}>("get_wiki_page", { slug, maxChars: 40 });
		expect(first.content).toHaveLength(40);
		expect(first.totalChars).toBe(content.length);
		expect(first.outline).toEqual(["# Intro", "## Details"]);
		expect(first).toHaveProperty("revisionId");

		let text = first.content;
		let next = first.next;
		while (next) {
			const w = await tool<{ content: string; next?: string }>("get_wiki_page", {
				slug,
				maxChars: 40,
				cursor: next,
			});
			text += w.content;
			next = w.next;
		}
		expect(text).toBe(content);
	});

	it("get_wiki_page: contentTruncated is set on a partial window and absent on a whole page", async () => {
		const slug = await makeWiki(`# T\n${"q".repeat(200)}`);
		const part = await tool<{ contentTruncated?: boolean }>("get_wiki_page", {
			slug,
			maxChars: 50,
		});
		expect(part.contentTruncated).toBe(true);
		const whole = await tool<Record<string, unknown>>("get_wiki_page", { slug });
		expect(whole).not.toHaveProperty("contentTruncated");
	});

	it("get_wiki_page: default window returns a small page whole", async () => {
		const slug = await makeWiki("# Only\nshort");
		const page = await tool<{ content: string; next?: string; totalChars: number }>(
			"get_wiki_page",
			{ slug }
		);
		expect(page.content).toBe("# Only\nshort");
		expect(page.next).toBeUndefined();
		expect(page.totalChars).toBe(12);
	});

	it("get_wiki_page: section returns just that section; a miss returns the outline", async () => {
		const slug = await makeWiki("# Top\nintro\n## Alpha\nalpha text\n## Beta\nbeta text\n");
		const hit = await tool<{ content: string; section: string }>("get_wiki_page", {
			slug,
			section: "alpha",
		});
		expect(hit.content).toBe("## Alpha\nalpha text");

		const miss = await tool<{ sectionFound: boolean; outline: string[]; content?: string }>(
			"get_wiki_page",
			{ slug, section: "gamma" }
		);
		expect(miss.sectionFound).toBe(false);
		expect(miss.outline).toEqual(["# Top", "## Alpha", "## Beta"]);
		expect(miss).not.toHaveProperty("content");
	});

	it("get_wiki_page: maxChars is validated and a multi-byte boundary is not split", async () => {
		const slug = await makeWiki("😀".repeat(10));
		const bad = await call("get_wiki_page", { slug, maxChars: 99_999 });
		expect(bad.result?.isError).toBe(true);
		const w = await tool<{ content: string; next?: string }>("get_wiki_page", {
			slug,
			maxChars: 3,
		});
		expect(w.content).toBe("😀");
		expect(w.next).toBe("2");
	});
});
