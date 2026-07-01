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
				return `[${displayText}](?slug=${encodeURIComponent(slug)})`;
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
