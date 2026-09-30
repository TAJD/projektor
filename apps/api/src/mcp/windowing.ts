import { ValidationError } from "../services/errors";

// PROJ-892: windowed reads of long text (wiki pages, issue bodies) so one call never
// returns an unbounded blob. Offsets are UTF-16 code units (JS string indices) and are
// only ever placed on code-point boundaries, so a window never splits an emoji.

export const WIKI_DEFAULT_MAX_CHARS = 8_000;
export const WIKI_MAX_CHARS = 20_000;
export const ISSUE_BODY_MAX_CHARS = 16_000;
export const LIST_BODY_MAX_CHARS = 1_000;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** Pull `end` back so it doesn't fall between the halves of a surrogate pair. */
function safeEnd(text: string, end: number): number {
	if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) return end - 1;
	return end;
}

export type TextWindow = { text: string; totalChars: number; next?: string };

/**
 * A window of `text` from `cursor` (a previous `next`, default 0) of at most `max` chars.
 * `next` is present iff more text follows.
 */
export function windowText(text: string, opts: { max: number; cursor?: string }): TextWindow {
	let start = 0;
	if (opts.cursor !== undefined) {
		start = Number(opts.cursor);
		if (!Number.isInteger(start) || start < 0 || start > text.length) {
			throw new ValidationError({ formErrors: [], fieldErrors: { cursor: ["invalid cursor"] } });
		}
	}
	let end = safeEnd(text, Math.min(text.length, start + opts.max));
	// A window smaller than one code point (max:1 on an emoji) must still make progress.
	if (end <= start && start < text.length)
		end = start + (isHighSurrogate(text.charCodeAt(start)) ? 2 : 1);
	return {
		text: text.slice(start, end),
		totalChars: text.length,
		...(end < text.length ? { next: String(end) } : {}),
	};
}

type Heading = { level: number; text: string; start: number };

/** ATX headings outside fenced code blocks and outside a leading frontmatter block. */
function headings(content: string): Heading[] {
	const out: Heading[] = [];
	let pos = 0;
	let fence: string | null = null;
	let first = true;
	let inFrontmatter = false;
	for (const line of content.split("\n")) {
		const lineStart = pos;
		pos += line.length + 1;
		if (first) {
			first = false;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			if (fence === null) fence = fenceMatch[1];
			else if (fenceMatch[1] === fence) fence = null;
			continue;
		}
		if (fence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (m) out.push({ level: m[1].length, text: m[2], start: lineStart });
	}
	return out;
}

/** The page outline as `## Heading` strings, in document order. */
export function outlineOf(content: string): string[] {
	return headings(content).map((h) => `${"#".repeat(h.level)} ${h.text}`);
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}

/**
 * The section titled `name` (matched on heading text or its slug, case-insensitively,
 * with or without leading #s): the heading through to the next heading of the same or a
 * higher level. Undefined on a miss.
 */
export function sectionOf(content: string, name: string): string | undefined {
	const wanted = name
		.replace(/^#+\s*/, "")
		.trim()
		.toLowerCase();
	const hs = headings(content);
	const i = hs.findIndex((h) => h.text.toLowerCase() === wanted || slugify(h.text) === wanted);
	if (i < 0) return undefined;
	const next = hs.slice(i + 1).find((h) => h.level <= hs[i].level);
	return content.slice(hs[i].start, next ? next.start : content.length).replace(/\n+$/, "");
}

/** `bodyChars` on lists: a prefix of the body, flagged when it was cut. */
export function bodyPreview(body: unknown, chars: number): { body: string; bodyTruncated?: true } {
	const text = typeof body === "string" ? body : "";
	if (text.length <= chars) return { body: text };
	return { body: text.slice(0, safeEnd(text, chars)), bodyTruncated: true };
}
