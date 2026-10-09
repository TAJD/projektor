// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMd, stripFrontmatter } from "./markdown";

// PROJ-488 (R6): frontmatter is metadata, not prose — the rendered view drops it.
describe("stripFrontmatter", () => {
	it("removes a leading YAML frontmatter block", () => {
		const md = "---\ntype: runbook\ntags: [ops]\n---\n# Heading\n\nBody.";
		expect(stripFrontmatter(md)).toBe("# Heading\n\nBody.");
	});

	it("is CRLF-tolerant", () => {
		expect(stripFrontmatter("---\r\ntype: adr\r\n---\r\nBody.")).toBe("Body.");
	});

	it("leaves content without a leading frontmatter block untouched", () => {
		const md = "# Heading\n\nBody.\n\n---\n";
		expect(stripFrontmatter(md)).toBe(md);
	});

	it("does not strip a block that isn't at the very start", () => {
		const md = "Intro.\n\n---\ntype: runbook\n---\n";
		expect(stripFrontmatter(md)).toBe(md);
	});
});

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

// PROJ-605: wrapping in a div (not `display: block` on <table> itself) keeps the
// table's own display: table intact, so consumers' CSS can size the wrapper for
// scroll without shrinking a narrow table to content width.
describe("renderMd — table rendering (PROJ-605)", () => {
	it("wraps a rendered table in a .table-scroll div", () => {
		const html = renderMd("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
		const wrapStart = html.indexOf('<div class="table-scroll">');
		expect(wrapStart).toBeGreaterThan(-1);
		const tableStart = html.indexOf("<table", wrapStart);
		expect(tableStart).toBeGreaterThan(wrapStart);
		const closeTableEnd = html.indexOf("</table>") + "</table>".length;
		expect(html.slice(closeTableEnd).trim()).toBe("</div>");
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
		expect(initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "neutral" });
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0].nodes).toHaveLength(1);

		vi.doUnmock("mermaid");
		vi.resetModules();
	});

	async function withMermaid(run: ReturnType<typeof vi.fn>, initialize = vi.fn()) {
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const mod = await import("./markdown");
		const container = document.createElement("div");
		container.innerHTML = '<pre class="mermaid">graph TD\nA --> B</pre>';
		document.body.appendChild(container);
		return { render: mod.renderMermaidDiagrams, container, initialize };
	}

	afterEach(() => {
		document.documentElement.removeAttribute("data-theme");
		document.body.innerHTML = "";
		vi.doUnmock("mermaid");
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("uses mermaid's dark theme when the app theme is dark", async () => {
		document.documentElement.setAttribute("data-theme", "dark");
		const { render, container, initialize } = await withMermaid(vi.fn());
		await render(container);
		expect(initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "dark" });
	});

	it("re-draws from the original source when the theme is toggled", async () => {
		const run = vi.fn().mockImplementation(async ({ nodes }: { nodes: HTMLElement[] }) => {
			nodes[0].innerHTML = "<svg></svg>";
		});
		const { render, container, initialize } = await withMermaid(run);
		await render(container);
		await render(container);
		expect(run).toHaveBeenCalledTimes(1);

		document.documentElement.setAttribute("data-theme", "dark");
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
		expect(initialize).toHaveBeenLastCalledWith({ startOnLoad: false, theme: "dark" });
		expect(container.querySelector("pre.mermaid")?.getAttribute("data-mermaid-src")).toBe(
			"graph TD\nA --> B"
		);
	});

	it("leaves diagrams inside a display:none ancestor unrendered until they are shown", async () => {
		const run = vi.fn().mockImplementation(async ({ nodes }: { nodes: HTMLElement[] }) => {
			nodes[0].innerHTML = "<svg></svg>";
		});
		const { render, container } = await withMermaid(run);
		container.style.display = "none";
		await render(container);
		expect(run).not.toHaveBeenCalled();

		container.style.display = "";
		await render(container);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("serialises overlapping renders so a second call never resets a node mid-draw", async () => {
		let active = 0;
		let overlapped = false;
		const run = vi.fn().mockImplementation(async () => {
			active++;
			if (active > 1) overlapped = true;
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		const { render, container } = await withMermaid(run);
		const first = render(container);
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
		document.documentElement.setAttribute("data-theme", "dark");
		const second = render(container);
		await Promise.all([first, second]);
		expect(overlapped).toBe(false);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("keeps the source, shows a note and warns when a diagram fails to render", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const run = vi.fn().mockRejectedValue(new Error("Parse error on line 2\nExpecting 'X'"));
		const { render, container } = await withMermaid(run);

		await expect(render(container)).resolves.toBeUndefined();

		expect(container.querySelector("pre.mermaid")?.textContent).toBe("graph TD\nA --> B");
		const note = container.querySelector(".mermaid-error");
		expect(note?.textContent).toBe("Diagram failed to render: Parse error on line 2");
		expect(warn).toHaveBeenCalled();
	});

	it("shows the same note when the mermaid chunk fails to load", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.doMock("mermaid", () => {
			throw new Error("Failed to fetch dynamically imported module");
		});
		vi.resetModules();
		const { renderMermaidDiagrams: render } = await import("./markdown");
		const container = document.createElement("div");
		container.innerHTML = '<pre class="mermaid">graph TD\nA --> B</pre>';

		await expect(render(container)).resolves.toBeUndefined();

		expect(container.querySelector(".mermaid-error")?.textContent).toContain(
			"Diagram failed to render"
		);
		expect(container.querySelector("pre.mermaid")?.textContent).toBe("graph TD\nA --> B");
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
