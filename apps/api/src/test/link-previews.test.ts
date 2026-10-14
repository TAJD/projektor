// PROJ-1036: link preview cards — GET /api/link-preview and get_link_preview.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
	excerpt,
	getLinkPreview,
	getLinkPreviewImage,
	headingForFragment,
	isBlockedHost,
	type LinkPreview,
	parseHtmlMetadata,
} from "../services/link-previews";
import type { ServiceCtx } from "../services/types";
import {
	authHeaders,
	type JsonRpcResult,
	seedFixture,
	seedIssue,
	seedIssueFixture,
	seedProject,
	seedProjectFixture,
	toolError,
} from "./helpers";

function ctxFor(workspaceId: string, userId: string): ServiceCtx {
	return { db: env.DB, kv: env.KV, r2: env.R2, workspaceId, userId, role: "member" } as ServiceCtx;
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
	return new Response(html, {
		status: 200,
		...init,
		headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
	});
}

function previewUrl(url: string): string {
	return `http://localhost/api/link-preview?url=${encodeURIComponent(url)}`;
}

async function mcpCall(workspaceId: string, token: string, slug: string, args: unknown) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_link_preview", arguments: args },
		}),
	});
	return (await res.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
}

describe("parseHtmlMetadata", () => {
	const base = new URL("https://example.com/post/1");

	it("prefers OpenGraph tags and resolves a relative image", () => {
		const meta = parseHtmlMetadata(
			`<html><head><title>Fallback</title>
			<meta property="og:title" content="The &amp; Title">
			<meta content='A description' property='og:description'>
			<meta property="og:image" content="/img/card.png">
			<meta property="og:site_name" content="Example">
			</head></html>`,
			base
		);
		expect(meta).toEqual({
			title: "The & Title",
			description: "A description",
			image: "https://example.com/img/card.png",
			siteName: "Example",
		});
	});

	it("falls back to <title>, meta description and the hostname", () => {
		const meta = parseHtmlMetadata(
			`<title>  Plain
			 page </title><meta name="description" content="Hello &#8212; world">`,
			base
		);
		expect(meta).toEqual({
			title: "Plain page",
			description: "Hello — world",
			image: null,
			siteName: "example.com",
		});
	});

	it("drops a non-http(s) image", () => {
		const meta = parseHtmlMetadata(
			`<meta property="og:title" content="X"><meta property="og:image" content="javascript:alert(1)">`,
			base
		);
		expect(meta.image).toBeNull();
	});
});

describe("isBlockedHost", () => {
	it.each([
		"localhost",
		"intranet",
		"127.0.0.1",
		"10.0.0.5",
		"169.254.169.254",
		"0x7f000001",
		"[::1]",
		"printer.local",
		"db.internal",
		"foo.localhost",
	])("blocks %s", (host) => {
		expect(isBlockedHost(host)).toBe(true);
	});

	it.each(["example.com", "github.com", "docs.example.co.uk"])("allows %s", (host) => {
		expect(isBlockedHost(host)).toBe(false);
	});
});

describe("excerpt", () => {
	it("strips frontmatter and markdown syntax", () => {
		expect(excerpt("---\ntype: doc\n---\n# Heading\n\nSome **bold** [link](http://x) text.")).toBe(
			"Heading Some bold link text."
		);
	});

	it("returns null for empty content and truncates long content", () => {
		expect(excerpt("   ")).toBeNull();
		const long = excerpt("a".repeat(500));
		expect(long?.length).toBe(200);
		expect(long?.endsWith("…")).toBe(true);
	});
});

describe("getLinkPreview — external", () => {
	it("fetches and parses an HTML page, then serves it from cache", async () => {
		const { workspace, user } = await seedFixture();
		const ctx = ctxFor(workspace.id, user.id);
		const fetchImpl = vi.fn(async () =>
			htmlResponse(`<meta property="og:title" content="Cached page">`)
		);
		const url = `https://example.com/${crypto.randomUUID()}`;

		const first = await getLinkPreview(ctx, { url }, { fetch: fetchImpl as typeof fetch });
		expect(first).toMatchObject({ kind: "external", title: "Cached page", url });
		const second = await getLinkPreview(ctx, { url }, { fetch: fetchImpl as typeof fetch });
		expect(second).toEqual(first);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("follows a redirect to a public host", async () => {
		const { workspace, user } = await seedFixture();
		const fetchImpl = vi.fn(async (input: string) =>
			input.startsWith("https://short.example/")
				? new Response(null, { status: 301, headers: { location: "https://example.org/final" } })
				: htmlResponse("<title>Final</title>")
		);
		const preview = await getLinkPreview(
			ctxFor(workspace.id, user.id),
			{ url: `https://short.example/${crypto.randomUUID()}` },
			{ fetch: fetchImpl as unknown as typeof fetch }
		);
		expect(preview.title).toBe("Final");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("refuses a redirect into a private address", async () => {
		const { workspace, user } = await seedFixture();
		const fetchImpl = vi.fn(async (input: string) =>
			input.includes("169.254")
				? htmlResponse("<title>metadata service</title>")
				: new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
		);
		const preview = await getLinkPreview(
			ctxFor(workspace.id, user.id),
			{ url: `https://example.net/${crypto.randomUUID()}` },
			{ fetch: fetchImpl as unknown as typeof fetch }
		);
		expect(preview.title).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("returns an empty preview for a non-HTML response or a fetch failure", async () => {
		const { workspace, user } = await seedFixture();
		const ctx = ctxFor(workspace.id, user.id);
		const pdf = await getLinkPreview(
			ctx,
			{ url: `https://example.com/${crypto.randomUUID()}.pdf` },
			{
				fetch: (async () =>
					new Response("%PDF", { headers: { "content-type": "application/pdf" } })) as typeof fetch,
			}
		);
		expect(pdf.title).toBeNull();
		const failed = await getLinkPreview(
			ctx,
			{ url: `https://example.com/${crypto.randomUUID()}` },
			{
				fetch: (async () => {
					throw new Error("network down");
				}) as typeof fetch,
			}
		);
		expect(failed).toMatchObject({ kind: "external", title: null });
	});
});

describe("GET /api/link-preview", () => {
	it.each([
		"http://localhost/admin",
		"http://127.0.0.1/",
		"https://example.com:8443/",
		"ftp://example.com/file",
		"javascript:alert(1)",
		"https://user:pass@example.com/",
	])("refuses %s with 400", async (url) => {
		const { workspace, token } = await seedFixture();
		const res = await SELF.fetch(previewUrl(url), { headers: authHeaders(token, workspace.slug) });
		expect(res.status).toBe(400);
	});

	it("previews an issue path with its ref and status", async () => {
		const { token, slug, issueId } = await seedIssueFixture({ issueTitle: "Fix the widget" });
		const number = (await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
			.bind(issueId)
			.first<{ number: number }>())!.number;
		const res = await SELF.fetch(previewUrl(`/projects/PROJ/issues/${number}/fix-the-widget`), {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as LinkPreview;
		expect(body).toMatchObject({
			kind: "issue",
			title: "Fix the widget",
			ref: `PROJ-${number}`,
			status: "backlog",
		});

		const byId = await SELF.fetch(previewUrl(`/issues/view?id=${issueId}`), {
			headers: authHeaders(token, slug),
		});
		expect(((await byId.json()) as LinkPreview).title).toBe("Fix the widget");
	});

	it("answers 404 for an issue in a project the caller can't see", async () => {
		const { workspace, user, token } = await seedFixture();
		const hidden = await seedProject(workspace.id, "HID");
		const issue = await seedIssue(workspace.id, hidden.id, user.id, { title: "Secret" });
		const res = await SELF.fetch(previewUrl(`/projects/HID/issues/${issue.number}`), {
			headers: authHeaders(token, workspace.slug),
		});
		expect(res.status).toBe(404);
	});

	it("previews a wiki page path", async () => {
		const { workspace, token } = await seedFixture();
		const created = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, workspace.slug),
			body: JSON.stringify({ title: "Runbook", content: "# Runbook\n\nHow to deploy." }),
		});
		const page = (await created.json()) as { slug: string };
		const res = await SELF.fetch(previewUrl(`/wiki/${page.slug}`), {
			headers: authHeaders(token, workspace.slug),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			kind: "wiki",
			title: "Runbook",
			description: "How to deploy.",
		});
	});

	it("answers 404 for an unknown app path", async () => {
		const { workspace, token } = await seedFixture();
		const res = await SELF.fetch(previewUrl("/settings/tokens"), {
			headers: authHeaders(token, workspace.slug),
		});
		expect(res.status).toBe(404);
	});
});

describe("get_link_preview (MCP)", () => {
	it("returns the same shape as REST for an issue path", async () => {
		const { token, slug, workspaceId, issueId } = await seedIssueFixture({ issueTitle: "Parity" });
		const number = (await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
			.bind(issueId)
			.first<{ number: number }>())!.number;
		const path = `/projects/PROJ/issues/${number}`;
		const rest = await (
			await SELF.fetch(previewUrl(path), { headers: authHeaders(token, slug) })
		).json();
		const mcp = await mcpCall(workspaceId, token, slug, { url: path });
		expect(JSON.parse(mcp.result.content[0].text)).toEqual(rest);
	});

	it("refuses a private URL as a validation error", async () => {
		const { workspace, token } = await seedFixture();
		const res = await mcpCall(workspace.id, token, workspace.slug, { url: "http://10.0.0.1/" });
		expect(toolError(res)?.code).toBe("validation");
	});
});

// ─── PROJ-1037 ────────────────────────────────────────────────────────────────

describe("headingForFragment", () => {
	const md = [
		"---",
		"type: doc",
		"---",
		"# Intro",
		"## Set **up**",
		"```",
		"# not a heading",
		"```",
		"## Set up",
		"#### Too deep",
		"## !!!",
	].join("\n");

	it("finds a heading by the id the wiki page gives it", () => {
		expect(headingForFragment(md, "intro")).toBe("Intro");
		expect(headingForFragment(md, "set-up")).toBe("Set up");
		expect(headingForFragment(md, "set-up-1")).toBe("Set up");
		expect(headingForFragment(md, "section-4")).toBe("!!!");
	});

	it("ignores code blocks, deep headings and unknown ids", () => {
		expect(headingForFragment(md, "not-a-heading")).toBeNull();
		expect(headingForFragment(md, "too-deep")).toBeNull();
		expect(headingForFragment(md, "nope")).toBeNull();
		expect(headingForFragment(md, "%E0%A4%A")).toBeNull();
	});
});

describe("internal previews — details (PROJ-1037)", () => {
	it("returns an issue's type, priority, assignee and update time", async () => {
		const { token, slug, workspaceId, projectId, userId } = await seedProjectFixture();
		await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("Ada", userId).run();
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Detailed",
			priority: "high",
			assigneeId: userId,
		});
		const res = await SELF.fetch(previewUrl(`/projects/PROJ/issues/${issue.number}`), {
			headers: authHeaders(token, slug),
		});
		expect(await res.json()).toMatchObject({
			kind: "issue",
			priority: "high",
			assignee: "Ada",
			updatedAt: issue.createdAt,
			section: null,
		});
	});

	it("leaves priority and assignee null when unset", async () => {
		const { token, slug, workspaceId, projectId, userId } = await seedProjectFixture();
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Bare" });
		const res = await SELF.fetch(previewUrl(`/projects/PROJ/issues/${issue.number}`), {
			headers: authHeaders(token, slug),
		});
		expect(await res.json()).toMatchObject({ priority: null, assignee: null });
	});

	it("names the wiki section a #fragment points at", async () => {
		const { workspace, token } = await seedFixture();
		const created = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, workspace.slug),
			body: JSON.stringify({ title: "Guide", content: "# Guide\n\n## Install steps\n\nRun it." }),
		});
		const page = (await created.json()) as { slug: string };
		const res = await SELF.fetch(previewUrl(`/wiki/${page.slug}#install-steps`), {
			headers: authHeaders(token, workspace.slug),
		});
		const body = (await res.json()) as LinkPreview;
		expect(body).toMatchObject({ kind: "wiki", title: "Guide", section: "Install steps" });
		expect(body.updatedAt).toEqual(expect.any(Number));

		const unknown = await SELF.fetch(previewUrl(`/wiki/${page.slug}#missing`), {
			headers: authHeaders(token, workspace.slug),
		});
		expect(((await unknown.json()) as LinkPreview).section).toBeNull();
	});
});

describe("getLinkPreviewImage (PROJ-1037)", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

	// Each call gets its own image URL: images are cached by URL across tests.
	function site(image: () => Response) {
		const id = crypto.randomUUID();
		return vi.fn(async (input: string) =>
			input.includes("/img/")
				? image()
				: htmlResponse(
						`<meta property="og:title" content="Page"><meta property="og:image" content="/img/${id}">`
					)
		);
	}

	it("serves the page's preview image, then from cache", async () => {
		const { workspace, user } = await seedFixture();
		const ctx = ctxFor(workspace.id, user.id);
		const fetchImpl = site(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
		const url = `https://example.com/${crypto.randomUUID()}`;
		const deps = { fetch: fetchImpl as unknown as typeof fetch };

		const first = await getLinkPreviewImage(ctx, { url }, deps);
		expect(first.contentType).toBe("image/png");
		expect(new Uint8Array(first.body)).toEqual(PNG);
		const second = await getLinkPreviewImage(ctx, { url }, deps);
		expect(new Uint8Array(second.body)).toEqual(PNG);
		expect(fetchImpl).toHaveBeenCalledTimes(2); // page + image, once each
	});

	it("refuses SVG, oversized and non-image responses", async () => {
		const { workspace, user } = await seedFixture();
		const ctx = ctxFor(workspace.id, user.id);
		const cases: Array<[string, () => Response]> = [
			["svg", () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })],
			[
				"big",
				() =>
					new Response(new Uint8Array(3 * 1024 * 1024), {
						headers: { "content-type": "image/png" },
					}),
			],
			["html", () => htmlResponse("<p>not an image</p>")],
		];
		for (const [name, image] of cases) {
			const url = `https://example.com/${name}-${crypto.randomUUID()}`;
			await expect(
				getLinkPreviewImage(ctx, { url }, { fetch: site(image) as unknown as typeof fetch })
			).rejects.toMatchObject({ kind: "not_found" });
		}
	});

	it("404s for a page with no image and for app paths", async () => {
		const { workspace, user, token } = await seedFixture();
		const ctx = ctxFor(workspace.id, user.id);
		const fetchImpl = (async () => htmlResponse("<title>No image</title>")) as typeof fetch;
		await expect(
			getLinkPreviewImage(
				ctx,
				{ url: `https://example.com/${crypto.randomUUID()}` },
				{ fetch: fetchImpl }
			)
		).rejects.toMatchObject({ kind: "not_found" });

		const res = await SELF.fetch(
			`http://localhost/api/link-preview/image?url=${encodeURIComponent("/wiki/x")}`,
			{ headers: authHeaders(token, workspace.slug) }
		);
		expect(res.status).toBe(404);
	});

	it("resolves the workspace from ?workspace= for <img> loads", async () => {
		const { workspace, token } = await seedFixture();
		const res = await SELF.fetch(
			`http://localhost/api/link-preview/image?url=${encodeURIComponent("/wiki/x")}&workspace=${workspace.slug}`,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		// 404 from the service, not 400 "workspace required" from the middleware.
		expect(res.status).toBe(404);
	});
});
