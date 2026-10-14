import { drizzle, schema } from "@projektor/db";
import { eq } from "drizzle-orm";
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
 * browser falls back to a plain link. Fields that don't apply to a kind are null.
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
	/** Issue only (PROJ-1037): task type name, priority (null for "none") and assignee name. */
	type: string | null;
	priority: string | null;
	assignee: string | null;
	/** Issue and wiki: last update, unix seconds. */
	updatedAt: number | null;
	/** Wiki only: the heading a `#fragment` link points at, when it matches one. */
	section: string | null;
}

export interface LinkPreviewDeps {
	/** Injected in tests; defaults to the Worker's global fetch. */
	fetch?: typeof fetch;
}

// v2: PROJ-1037 added fields, so v1 entries (missing them) are never read back.
const CACHE_PREFIX = "link-preview:v2:";
const IMAGE_CACHE_PREFIX = "link-preview-image:v1:";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const FAILURE_CACHE_TTL_SECONDS = 60 * 60;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
// <head> is almost always inside the first few KB; 256 KB covers pages that inline a
// lot of CSS/JS before their meta tags without reading whole documents.
const MAX_HTML_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Raster only: an SVG can carry script, and these are the types every browser renders.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
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
		return wikiPreview(ctx, path, slug, parsed.hash.slice(1));
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
	const priority = issue.priority as string | null;
	return {
		...emptyPreview(url),
		kind: "issue",
		title: (issue.title as string) ?? null,
		description: excerpt((issue.body as string | null) ?? ""),
		ref: key ? `${key}-${issue.number}` : null,
		status: (issue.status_name as string | null) ?? (issue.status as string | null) ?? null,
		type: (issue.type_name as string | null) ?? null,
		priority: priority && priority !== "none" ? priority : null,
		assignee: await userName(ctx, issue.assignee_id as string | null),
		updatedAt: (issue.updated_at as number | null) ?? null,
	};
}

async function userName(ctx: ServiceCtx, userId: string | null): Promise<string | null> {
	if (!userId) return null;
	const row = await drizzle(ctx.db, { schema })
		.select({ name: schema.users.name, email: schema.users.email })
		.from(schema.users)
		.where(eq(schema.users.id, userId))
		.get();
	return row?.name || row?.email || null;
}

async function wikiPreview(
	ctx: ServiceCtx,
	url: string,
	slug: string,
	fragment: string
): Promise<LinkPreview> {
	const page = await getWikiPage(ctx, slug);
	return {
		...emptyPreview(url),
		kind: "wiki",
		title: page.title,
		description: excerpt(withoutTitleHeading(page.content ?? "", page.title)),
		siteName: "Wiki",
		updatedAt: page.updated_at ?? null,
		section: fragment ? headingForFragment(page.content ?? "", fragment) : null,
	};
}

/** Drop a first heading that just repeats the page title, so the excerpt starts with prose. */
function withoutTitleHeading(markdown: string, title: string): string {
	const body = markdown.replace(FRONTMATTER, "");
	const m = body.match(/^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
	return m && m[1].trim().toLowerCase() === title.trim().toLowerCase()
		? body.slice(m[0].length)
		: body;
}

/**
 * The text of the heading whose anchor id is `fragment`. Ids are assigned the way the
 * wiki page does it (WikiPage.tsx#assignHeadingIds): h1–h3, slugified text, `-1`, `-2`…
 * suffixes for repeats, `section-N` for a heading with no slug-able text.
 */
export function headingForFragment(markdown: string, fragment: string): string | null {
	let id: string;
	try {
		id = decodeURIComponent(fragment);
	} catch {
		return null;
	}
	const used = new Set<string>();
	let inFence = false;
	let index = 0;
	for (const line of markdown.replace(FRONTMATTER, "").split(/\r?\n/)) {
		if (/^[ \t]*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) continue;
		const m = line.match(/^ {0,3}#{1,3}[ \t]+(.+?)[ \t#]*$/);
		if (!m) continue;
		index++;
		const text = m[1]
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[*_`~]/g, "")
			.trim();
		const slug = text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const base = slug || `section-${index}`;
		let candidate = base;
		for (let n = 1; used.has(candidate); n++) candidate = `${base}-${n}`;
		used.add(candidate);
		if (candidate === id) return truncate(text, 200);
	}
	return null;
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
		type: null,
		priority: null,
		assignee: null,
		updatedAt: null,
		section: null,
	};
}

/**
 * GET `target`, following up to MAX_REDIRECTS redirects and re-validating every hop (a
 * public page must not redirect us somewhere private). Null on any failure or non-2xx.
 */
async function fetchPublic(
	target: URL,
	fetchImpl: typeof fetch,
	accept: string
): Promise<{ res: Response; url: URL } | null> {
	let current = target;
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const res = await fetchImpl(current.href, {
				redirect: "manual",
				headers: { "User-Agent": USER_AGENT, Accept: accept },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
			if (!location) {
				if (res.ok) return { res, url: current };
				await res.body?.cancel();
				return null;
			}
			await res.body?.cancel();
			current = parseExternalUrl(new URL(location, current).href);
		}
	} catch {
		return null;
	}
	return null;
}

async function fetchExternalPreview(target: URL, fetchImpl: typeof fetch): Promise<LinkPreview> {
	const empty = emptyPreview(target.href);
	const fetched = await fetchPublic(target, fetchImpl, "text/html,application/xhtml+xml");
	if (!fetched) return empty;
	const { res, url: current } = fetched;
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

// ---------------------------------------------------------------------------
// Card images (PROJ-1037), proxied so the viewer's browser never contacts the linked site.
// ---------------------------------------------------------------------------

export interface LinkPreviewImage {
	body: ArrayBuffer;
	contentType: string;
}

/**
 * The image of an external page's preview, fetched by the Worker. `url` is the *page*
 * URL, not the image URL, so this can only ever fetch an image some preview advertised:
 * it is not a general-purpose proxy. Any failure is a 404; the card then drops its image.
 */
export async function getLinkPreviewImage(
	ctx: ServiceCtx,
	raw: unknown,
	deps: LinkPreviewDeps = {}
): Promise<LinkPreviewImage> {
	const result = GetLinkPreviewSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	if (result.data.url.startsWith("/")) throw new NotFoundError("Link preview image not found");
	const preview = await getLinkPreview(ctx, { url: result.data.url }, deps);
	if (!preview.image) throw new NotFoundError("Link preview image not found");

	let imageUrl: URL;
	try {
		imageUrl = parseExternalUrl(preview.image);
	} catch {
		throw new NotFoundError("Link preview image not found");
	}
	const key = IMAGE_CACHE_PREFIX + (await sha256hex(imageUrl.href));
	try {
		const hit = await ctx.kv.getWithMetadata<{ contentType: string }>(key, "arrayBuffer");
		if (hit.value && hit.metadata)
			return { body: hit.value, contentType: hit.metadata.contentType };
	} catch (err) {
		console.error("[link-preview] image cache read failed, refetching:", err);
	}

	const image = await fetchImage(imageUrl, deps.fetch ?? fetch);
	if (!image) throw new NotFoundError("Link preview image not found");
	try {
		await ctx.kv.put(key, image.body, {
			expirationTtl: CACHE_TTL_SECONDS,
			metadata: { contentType: image.contentType },
		});
	} catch (err) {
		console.error("[link-preview] image cache write failed, continuing:", err);
	}
	return image;
}

async function fetchImage(target: URL, fetchImpl: typeof fetch): Promise<LinkPreviewImage | null> {
	const fetched = await fetchPublic(target, fetchImpl, [...IMAGE_TYPES].join(","));
	if (!fetched) return null;
	const { res } = fetched;
	const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	const declared = Number(res.headers.get("content-length") ?? "0");
	if (!IMAGE_TYPES.has(contentType) || declared > MAX_IMAGE_BYTES) {
		await res.body?.cancel();
		return null;
	}
	try {
		const body = await readBytesCapped(res, MAX_IMAGE_BYTES);
		return body ? { body, contentType } : null;
	} catch {
		return null;
	}
}

/** The whole body, or null if it is longer than `maxBytes`. */
async function readBytesCapped(res: Response, maxBytes: number): Promise<ArrayBuffer | null> {
	const reader = res.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
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
