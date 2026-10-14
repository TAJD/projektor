import { GetLinkPreviewSchema } from "../schemas/link-previews";
import { get as cacheGet, set as cacheSet } from "./cache";
import { NotFoundError, ValidationError } from "./errors";
import { getIssue } from "./issues";
import type { ServiceCtx } from "./types";
import { getWikiPage } from "./wiki";

/**
 * PROJ-1036: the metadata a link preview card renders. One shape for every kind so the
 * browser (and an agent) never has to branch on it to read a title.
 *
 * - `external`: an http(s) page, from its OpenGraph / twitter / <title> / meta tags.
 * - `issue` / `wiki`: an app-relative path to an issue or wiki page in this workspace,
 *   from our own data. A hidden or missing target is a 404, exactly like reading it.
 *
 * `title: null` means "nothing worth a card" (fetch failed, not HTML, no title); the
 * browser falls back to a plain link.
 */
export interface LinkPreview {
	url: string;
	kind: "external" | "issue" | "wiki";
	title: string | null;
	description: string | null;
	image: string | null;
	siteName: string | null;
	ref: string | null;
	status: string | null;
}

export interface LinkPreviewDeps {
	/** Injected in tests; defaults to the Worker's global fetch. */
	fetch?: typeof fetch;
}

const CACHE_PREFIX = "link-preview:v1:";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const FAILURE_CACHE_TTL_SECONDS = 60 * 60;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
// <head> is almost always inside the first few KB; 256 KB covers pages that inline a
// lot of CSS/JS before their meta tags without reading whole documents.
const MAX_HTML_BYTES = 256 * 1024;
const USER_AGENT = "ProjektorLinkPreview/1.0 (+https://github.com/TAJD/projektor)";

const ISSUE_PATH = /^\/projects\/([A-Za-z][A-Za-z0-9]*)\/issues\/(\d{1,9})(?:\/[^/]*)?\/?$/;
const WIKI_PATH = /^\/wiki\/([^/]+)\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getLinkPreview(
	ctx: ServiceCtx,
	raw: unknown,
	deps: LinkPreviewDeps = {}
): Promise<LinkPreview> {
	const result = GetLinkPreviewSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { url } = result.data;

	if (url.startsWith("/") && !url.startsWith("//")) return internalPreview(ctx, url);

	const target = parseExternalUrl(url);
	const key = CACHE_PREFIX + (await sha256hex(target.href));
	const cached = await cacheGet<LinkPreview>(ctx.kv, key);
	if (cached) return cached;

	const preview = await fetchExternalPreview(target, deps.fetch ?? fetch);
	await cacheSet(
		ctx.kv,
		key,
		preview,
		preview.title ? CACHE_TTL_SECONDS : FAILURE_CACHE_TTL_SECONDS
	);
	return preview;
}

// ---------------------------------------------------------------------------
// Internal links (issues, wiki pages). Never cached: the answer depends on who asks.
// ---------------------------------------------------------------------------

async function internalPreview(ctx: ServiceCtx, path: string): Promise<LinkPreview> {
	const parsed = new URL(path, "http://internal.invalid");
	const pathname = parsed.pathname;

	const issueMatch = pathname.match(ISSUE_PATH);
	if (issueMatch) {
		return issuePreview(ctx, path, { ref: `${issueMatch[1].toUpperCase()}-${issueMatch[2]}` });
	}
	if (pathname === "/issues/view" || pathname === "/issues/view/") {
		const id = parsed.searchParams.get("id") ?? "";
		if (UUID.test(id)) return issuePreview(ctx, path, { id });
	}
	const wikiMatch = pathname.match(WIKI_PATH);
	if (wikiMatch) {
		let slug: string;
		try {
			slug = decodeURIComponent(wikiMatch[1]);
		} catch {
			throw new NotFoundError("Wiki page not found");
		}
		return wikiPreview(ctx, path, slug);
	}
	throw new NotFoundError("No preview for this link");
}

async function issuePreview(
	ctx: ServiceCtx,
	url: string,
	lookup: { id: string } | { ref: string }
): Promise<LinkPreview> {
	const issue = (await getIssue(ctx, lookup)) as Record<string, unknown>;
	const key = issue.project_key as string | null;
	return {
		url,
		kind: "issue",
		title: (issue.title as string) ?? null,
		description: excerpt((issue.body as string | null) ?? ""),
		image: null,
		siteName: null,
		ref: key ? `${key}-${issue.number}` : null,
		status: (issue.status_name as string | null) ?? (issue.status as string | null) ?? null,
	};
}

async function wikiPreview(ctx: ServiceCtx, url: string, slug: string): Promise<LinkPreview> {
	const page = await getWikiPage(ctx, slug);
	return {
		url,
		kind: "wiki",
		title: page.title,
		description: excerpt(page.content ?? ""),
		image: null,
		siteName: "Wiki",
		ref: null,
		status: null,
	};
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** A plain-text first ~200 characters of some markdown, for a card's description line. */
export function excerpt(markdown: string, max = 200): string | null {
	const text = markdown
		.replace(FRONTMATTER, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, t: string, l?: string) => l ?? t)
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---------------------------------------------------------------------------
// External links.
// ---------------------------------------------------------------------------

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];

/**
 * Only public http(s) hosts on default ports. Workers' fetch can't reach a private network
 * anyway; this is defence in depth (and keeps the Worker from fetching itself). IP-literal
 * hosts are refused outright rather than range-checked: a public page linked by IP is rare
 * enough that a plain link is a fine fallback, and it rules out every encoding trick.
 */
export function parseExternalUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw invalidUrl("url must be an absolute http(s) URL or an app path starting with /");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw invalidUrl("Only http and https links can be previewed");
	}
	if (url.username || url.password) throw invalidUrl("Links with credentials can't be previewed");
	if (url.port && url.port !== "80" && url.port !== "443") {
		throw invalidUrl("Only links on the default port can be previewed");
	}
	if (isBlockedHost(url.hostname)) throw invalidUrl("This host can't be previewed");
	url.hash = "";
	return url;
}

export function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host.includes(".")) return true; // localhost, intranet single-label names
	if (host.startsWith("[") || host.includes(":")) return true; // IPv6 literal
	if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return true; // IPv4 literal (any form)
	return BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

function invalidUrl(message: string): ValidationError {
	return new ValidationError({ formErrors: [], fieldErrors: { url: [message] } });
}

function emptyPreview(url: string): LinkPreview {
	return {
		url,
		kind: "external",
		title: null,
		description: null,
		image: null,
		siteName: null,
		ref: null,
		status: null,
	};
}

async function fetchExternalPreview(target: URL, fetchImpl: typeof fetch): Promise<LinkPreview> {
	const empty = emptyPreview(target.href);
	let current = target;
	let res: Response | undefined;
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			res = await fetchImpl(current.href, {
				redirect: "manual",
				headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
			if (!location) break;
			await res.body?.cancel();
			res = undefined;
			// Every hop is re-validated: a public page must not redirect us somewhere private.
			current = parseExternalUrl(new URL(location, current).href);
		}
	} catch {
		return empty;
	}
	if (!res?.ok) {
		await res?.body?.cancel();
		return empty;
	}
	const type = res.headers.get("content-type") ?? "";
	if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
		await res.body?.cancel();
		return empty;
	}
	let html: string;
	try {
		html = await readCapped(res, MAX_HTML_BYTES);
	} catch {
		return empty;
	}
	return { ...empty, ...parseHtmlMetadata(html, current) };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let out = "";
	let read = 0;
	while (read < maxBytes) {
		const { done, value } = await reader.read();
		if (done) break;
		read += value.byteLength;
		out += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return out + decoder.decode();
}

const META_TAG = /<meta\b[^>]*>/gi;
const ATTR = /([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

/** Pull title/description/image/site name out of an HTML document's meta tags. */
export function parseHtmlMetadata(
	html: string,
	base: URL
): Pick<LinkPreview, "title" | "description" | "image" | "siteName"> {
	const meta = new Map<string, string>();
	for (const tag of html.match(META_TAG) ?? []) {
		const attrs = new Map<string, string>();
		for (const m of tag.matchAll(ATTR)) {
			attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
		}
		const name = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
		const content = attrs.get("content");
		if (name && content !== undefined && !meta.has(name)) meta.set(name, content);
	}
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const v = clean(meta.get(k));
			if (v) return v;
		}
		return null;
	};
	const titleTag = clean(html.match(TITLE_TAG)?.[1]);
	const image = pick("og:image", "og:image:url", "twitter:image", "twitter:image:src");
	return {
		title: truncate(pick("og:title", "twitter:title") ?? titleTag, 300),
		description: truncate(pick("og:description", "twitter:description", "description"), 500),
		image: image ? safeImageUrl(image, base) : null,
		siteName: truncate(pick("og:site_name", "application-name") ?? base.hostname, 100),
	};
}

function safeImageUrl(raw: string, base: URL): string | null {
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href.length <= 2048 ? url.href : null;
	} catch {
		return null;
	}
}

function clean(value: string | undefined): string | null {
	if (value === undefined) return null;
	const text = decodeEntities(value.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
	return text || null;
}

function truncate(value: string | null, max: number): string | null {
	if (!value) return null;
	return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
