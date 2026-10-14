// PROJ-1036: pure helpers behind MarkdownEditor's paste-a-URL behaviour. A pasted URL
// goes in on its own paragraph (so markdown.ts renders it as a link card), and the
// popover can turn it back into an inline `[title](url)` link.

const URL_ONLY = /^https?:\/\/[^\s<>]+$/i;

/** The pasted text, if it is exactly one http(s) URL. */
export function pastedUrl(text: string): string | null {
	const t = text.trim();
	if (!URL_ONLY.test(t)) return null;
	try {
		new URL(t);
		return t;
	} catch {
		return null;
	}
}

/**
 * Whether a paste at `pos` should be left alone: inside a fenced code block, inside
 * inline code, right after `(`, `<` or `]` (the author is typing markdown by hand), or
 * on a list item, quote or table row, which a card's blank lines would break apart.
 */
export function isLiteralContext(doc: string, pos: number): boolean {
	const before = doc.slice(0, pos);
	if (((before.match(/^[ \t]*(```|~~~)/gm) ?? []).length & 1) === 1) return true;
	const lineStart = before.lastIndexOf("\n") + 1;
	const line = before.slice(lineStart);
	if (((line.match(/`/g) ?? []).length & 1) === 1) return true;
	if (/^\s*(?:[-*+]|\d+[.)]|>)\s/.test(line) || line.includes("|")) return true;
	return /[(<\]]$/.test(line);
}

export interface CardInsert {
	/** Full text to insert at the cursor: prefix + url + suffix. */
	insert: string;
	prefix: string;
	suffix: string;
	/** True when the prefix/suffix split text on the cursor's line (vs. only adding a blank line). */
	prefixSplit: boolean;
	suffixSplit: boolean;
}

/**
 * Newlines needed around `url` at `pos` so it is a paragraph of its own: a blank line
 * on each side, unless one is already there.
 */
export function planCardInsert(doc: string, pos: number, url: string): CardInsert {
	const lineStart = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
	const nextNl = doc.indexOf("\n", pos);
	const lineEnd = nextNl === -1 ? doc.length : nextNl;
	const textBefore = doc.slice(lineStart, pos);
	const textAfter = doc.slice(pos, lineEnd);
	const prevLine = lineStart === 0 ? null : lineAt(doc, lineStart - 1);
	const nextLine = nextNl === -1 ? null : lineAt(doc, nextNl + 1);

	const prefixSplit = textBefore.trim() !== "";
	const suffixSplit = textAfter.trim() !== "";
	const prefix = prefixSplit ? "\n\n" : prevLine !== null && prevLine.trim() !== "" ? "\n" : "";
	const suffix = suffixSplit ? "\n\n" : nextLine !== null && nextLine.trim() !== "" ? "\n" : "";
	return { insert: prefix + url + suffix, prefix, suffix, prefixSplit, suffixSplit };
}

/** The line containing `pos` (`pos` may be a line's trailing newline). */
function lineAt(doc: string, pos: number): string {
	const start = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
	const end = doc.indexOf("\n", pos);
	return doc.slice(start, end === -1 ? doc.length : end);
}

/**
 * The text that replaces a card insert when it is converted to an inline link: the
 * newlines that split a line are dropped, ones that only kept a paragraph apart stay.
 */
export function linkReplacement(plan: CardInsert, url: string, title: string | null): string {
	return (
		(plan.prefixSplit ? "" : plan.prefix) +
		markdownLink(title, url) +
		(plan.suffixSplit ? "" : plan.suffix)
	);
}

export function markdownLink(title: string | null, url: string): string {
	const text = (title ?? url)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/([\\[\]])/g, "\\$1");
	return `[${text}](${url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
}
