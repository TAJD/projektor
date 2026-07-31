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
			},
			"https://example.test/wiki/notes"
		);
		const html = await rewritten.text();

		expect(html).not.toContain("[[Other Page");
		expect(html).not.toContain("](https://example.com)");
		expect(html).toContain("Other Page");
		expect(html).toContain("a link");
	});
});
