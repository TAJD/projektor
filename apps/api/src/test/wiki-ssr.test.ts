import { describe, expect, it } from "vitest";
import { injectWikiMetadata } from "../lib/wiki-ssr";

const SHELL_HTML = `<!doctype html><html><head><title>Wiki — Projektor</title>
<meta property="og:title" content="Projektor — project management for humans and agents." />
<meta property="og:description" content="Projektor — project management for humans and agents." />
<meta property="og:url" content="https://example.test/wiki/view" />
</head><body></body></html>`;

describe("injectWikiMetadata", () => {
	it("rewrites title and og tags with the resolved page's real values", async () => {
		const response = new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
		const rewritten = injectWikiMetadata(
			response,
			{
				title: "Deploy Runbook",
				content: "Steps to deploy the service.",
				url: "/wiki/deploy-runbook",
				handoff: { requested: "deploy-runbook", workspaceSlug: "acme", page: {} },
			},
			"https://example.test/wiki/deploy-runbook"
		);
		const html = await rewritten.text();

		expect(html).toContain("<title>Deploy Runbook — Projektor Wiki</title>");
		expect(html).toContain('content="Deploy Runbook"');
		expect(html).toContain('content="Steps to deploy the service."');
		expect(html).toContain('content="https://example.test/wiki/deploy-runbook"');
	});

	it("strips markdown syntax from the injected description excerpt", async () => {
		const response = new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
		const rewritten = injectWikiMetadata(
			response,
			{
				title: "Notes",
				content: "# Heading\n\nSee [[Other Page|here]] and [a link](https://example.com).",
				url: "/wiki/notes",
				handoff: { requested: "notes", workspaceSlug: "acme", page: {} },
			},
			"https://example.test/wiki/notes"
		);
		const html = await rewritten.text();

		expect(html).not.toContain("[[Other Page");
		expect(html).not.toContain("](https://example.com)");
		expect(html).toContain("Other Page");
		expect(html).toContain("a link");
	});

	it("hands the page JSON to the island in a data block that page content cannot break out of", async () => {
		const response = new Response(SHELL_HTML, {
			headers: {
				"content-type": "text/html",
				"cache-control": "public, max-age=3600",
				etag: '"x"',
			},
		});
		const page = {
			id: "p1",
			slug: "evil",
			title: "Evil",
			content: "</script><script>alert(1)</script> & <!-- -->",
		};
		const rewritten = injectWikiMetadata(
			response,
			{
				title: page.title,
				content: page.content,
				url: "/wiki/evil",
				handoff: { requested: "evil", workspaceSlug: "acme", page },
			},
			"https://example.test/wiki/evil"
		);
		const html = await rewritten.text();

		const blocks = [
			...html.matchAll(
				/<script type="application\/json" id="wiki-ssr-handoff">([\s\S]*?)<\/script>/g
			),
		];
		expect(blocks).toHaveLength(1);
		expect(html.replace(/content="[^"]*"/g, "").match(/<script/g)).toHaveLength(1);
		expect(blocks[0][1]).not.toMatch(/[<>&]/);
		expect(JSON.parse(blocks[0][1])).toEqual({ requested: "evil", workspaceSlug: "acme", page });
		expect(rewritten.headers.get("cache-control")).toBe("private, no-cache");
		expect(rewritten.headers.get("etag")).toBeNull();
	});
});
