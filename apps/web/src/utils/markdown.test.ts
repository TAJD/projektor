// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderMd } from "./markdown";

describe("renderMd — XSS sanitization", () => {
	it("strips <script> tags", () => {
		const html = renderMd("hello <script>alert(1)</script> world");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("alert(1)");
		expect(html).toContain("hello");
		expect(html).toContain("world");
	});

	it("removes inline event handlers", () => {
		const html = renderMd('<img src="x" onerror="alert(1)">');
		expect(html.toLowerCase()).not.toContain("onerror");
		expect(html).not.toContain("alert(1)");
	});

	it("removes a div with an onclick handler attribute", () => {
		const html = renderMd('<div onclick="steal()">click</div>');
		expect(html.toLowerCase()).not.toContain("onclick");
		expect(html).not.toContain("steal()");
	});

	it("neutralizes javascript: hrefs", () => {
		const html = renderMd('<a href="javascript:alert(1)">x</a>');
		expect(html.toLowerCase()).not.toContain("javascript:");
	});

	it("strips a malicious SVG onload payload", () => {
		const html = renderMd('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
		expect(html.toLowerCase()).not.toContain("javascript:");
		expect(html).not.toContain("alert(1)");
	});

	it("strips an <iframe> injection", () => {
		const html = renderMd('<iframe src="https://evil.example"></iframe>');
		expect(html.toLowerCase()).not.toContain("<iframe");
	});
});

describe("renderMd — legitimate markdown still renders", () => {
	it("renders bold and italic", () => {
		const html = renderMd("**bold** and _italic_");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
	});

	it("renders a safe link with its href intact", () => {
		const html = renderMd("[example](https://example.com)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain(">example</a>");
	});

	it("renders fenced code blocks", () => {
		const html = renderMd("```\nconst x = 1;\n```");
		expect(html).toContain("<code");
		expect(html).toContain("const x = 1;");
	});

	it("renders lists", () => {
		const html = renderMd("- one\n- two");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>one</li>");
		expect(html).toContain("<li>two</li>");
	});
});

describe("renderMd — mermaid code blocks", () => {
	it('renders a ```mermaid fence as a <pre class="mermaid"> placeholder', () => {
		const html = renderMd("```mermaid\ngraph TD\n    A --> B\n```");
		expect(html).toContain('<pre class="mermaid">');
		expect(html).toContain("graph TD");
		expect(html).toContain("A --&gt; B");
	});

	it("does not treat other languages as mermaid", () => {
		const html = renderMd("```js\nconst x = 1;\n```");
		expect(html).not.toContain('class="mermaid"');
		expect(html).toContain("<code");
	});

	it("survives DOMPurify sanitization intact", () => {
		const html = renderMd("```mermaid\ngraph TD\n    A[<script>alert(1)</script>] --> B\n```");
		expect(html).toContain('<pre class="mermaid">');
		expect(html).not.toContain("<script");
	});
});

describe("renderMermaidDiagrams", () => {
	it("hydrates pre.mermaid nodes via mermaid.run", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { renderMermaidDiagrams: renderWithMock } = await import("./markdown");

		const container = document.createElement("div");
		container.innerHTML = '<pre class="mermaid">graph TD\nA --> B</pre>';
		document.body.appendChild(container);

		await renderWithMock(container);

		expect(initialize).toHaveBeenCalled();
		expect(run).toHaveBeenCalledWith({ nodes: expect.anything() });
		expect(run.mock.calls[0][0].nodes).toHaveLength(1);

		vi.doUnmock("mermaid");
		vi.resetModules();
	});

	it("does nothing (no import) when there are no mermaid blocks", async () => {
		const run = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize: vi.fn(), run } }));
		vi.resetModules();
		const { renderMermaidDiagrams: renderWithMock } = await import("./markdown");

		const container = document.createElement("div");
		container.innerHTML = "<p>no diagrams here</p>";

		await renderWithMock(container);

		expect(run).not.toHaveBeenCalled();

		vi.doUnmock("mermaid");
		vi.resetModules();
	});
});
