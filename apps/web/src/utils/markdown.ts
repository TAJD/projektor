import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Fenced ```mermaid blocks render as a `<pre class="mermaid">` placeholder that
// renderMermaidDiagrams() below hydrates into an SVG after the sanitized HTML
// is mounted in the DOM (marked/DOMPurify have no notion of mermaid).
const renderer = new marked.Renderer();
const defaultCode = renderer.code.bind(renderer);
renderer.code = (token: Tokens.Code) => {
	if (token.lang === "mermaid") {
		return `<pre class="mermaid">${escapeHtml(token.text)}</pre>`;
	}
	return defaultCode(token);
};

// PROJ-605: giving `.prose table` itself `display: block; overflow-x: auto` (the
// PROJ-603 fix) makes the *table* the block box that Typography's `width: 100%`
// sizes, while the anonymous table-formatting box inside it shrink-wraps to
// content — so a narrow table no longer spans the container. Wrapping the table
// in a real scroll div instead keeps the table itself `display: table` (full
// width, normal table layout) and puts the scroll boundary on the wrapper.
const defaultTable = renderer.table.bind(renderer);
renderer.table = (token: Tokens.Table) => `<div class="table-scroll">${defaultTable(token)}</div>`;

/**
 * Render untrusted markdown to sanitized HTML.
 *
 * Used for issue bodies, comments, and wiki content — all user-authored — so the
 * output is always passed through DOMPurify to strip scripts, event handlers, and
 * dangerous URLs before it reaches `dangerouslySetInnerHTML`.
 *
 * DOMPurify needs a DOM, so this returns "" during SSR (no `window`); the islands
 * that use it are client-rendered. Sanitization is covered by markdown.test.ts.
 */
export function renderMd(markdown: string): string {
	if (typeof window === "undefined") return "";
	return DOMPurify.sanitize(marked.parse(markdown, { renderer }) as string, {
		USE_PROFILES: { html: true },
	});
}

export const renderMarkdown = renderMd;

/**
 * Hydrate any `<pre class="mermaid">` placeholders inside `container` into
 * rendered SVG diagrams. Call after the sanitized HTML has been mounted.
 */
export async function renderMermaidDiagrams(container: Element): Promise<void> {
	const nodes = container.querySelectorAll<HTMLElement>("pre.mermaid");
	if (nodes.length === 0) return;
	const { default: mermaid } = await import("mermaid");
	mermaid.initialize({ startOnLoad: false, theme: "neutral" });
	await mermaid.run({ nodes });
}

// PROJ-488 (R6): a leading `---\n<yaml>\n---` block is metadata, not prose — the API
// parses it into the columns the metadata card renders from. Left in `content` (it's
// canonical markdown, edited as raw text and diffed in revisions), so the *rendered*
// view has to drop it; marked would otherwise turn the YAML into a setext <h2> that
// lands in the body and the table of contents. Mirrors the API's FRONTMATTER_RE.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_RE, "");
}

// PROJ-519 (accepted gap, see PROJ-482 PRD "Known gaps"): resolves by matching the
// literal `[[Title]]` text against the *current* titles of the client-fetched page
// list — not by id, even though the source-of-truth link graph (wiki_links,
// get_backlinks, R3) is id-backed and survives renames. The raw markdown only ever
// stores the title text typed at authoring time, never a page id, so matching an old
// [[Title]] against a renamed page's *current* title would need the server to expose
// this page's resolved wiki_links targets (id -> current slug/title) for the client to
// consult instead of doing its own title lookup — real new API surface, not a rename
// here. Net effect: renaming a page breaks its *rendered* backlinks (shown as broken,
// with a create-page affordance) even though get_backlinks still correctly reports the
// relationship by id. Deferred rather than fixed given this is a medium-priority item
// in an otherwise-low-priority backlog.
function resolveWikilinks(
	markdown: string,
	pages: ReadonlyArray<{ title: string; slug: string }>
): string {
	const titleMap = new Map(pages.map((p) => [p.title.toLowerCase(), p.slug]));
	return markdown.replace(
		/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
		(_, rawTitle: string, rawLabel: string | undefined) => {
			const title = rawTitle.trim();
			const displayText = rawLabel?.trim() ?? title;
			const slug = titleMap.get(title.toLowerCase());
			if (slug) {
				return `[${displayText}](/wiki/${encodeURIComponent(slug)})`;
			}
			const href = `?createTitle=${encodeURIComponent(title)}`;
			return `<span class="wiki-link-broken">${escapeHtml(displayText)} <a href="${href}">+</a></span>`;
		}
	);
}

/**
 * Like renderMd, but resolves [[Page Title]] and [[Page Title|label]] wikilinks
 * against the provided page list before rendering.
 *
 * Found links become standard wiki navigation links. Broken links (no matching page)
 * render as a muted span with a "+" affordance to create the missing page.
 */
export function renderMdWithWikilinks(
	markdown: string,
	pages: ReadonlyArray<{ title: string; slug: string }>
): string {
	if (typeof window === "undefined") return "";
	const resolved = resolveWikilinks(markdown, pages);
	return DOMPurify.sanitize(marked.parse(resolved, { renderer }) as string, {
		USE_PROFILES: { html: true },
	});
}
