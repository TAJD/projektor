import { relativeTime } from "../islands/issue-detail-helpers";
import { apiFetch } from "./api-client";

/** Mirrors the API's LinkPreview (services/link-previews.ts). */
export interface LinkPreview {
	url: string;
	kind: "external" | "issue" | "wiki";
	title: string | null;
	description: string | null;
	image: string | null;
	siteName: string | null;
	ref: string | null;
	status: string | null;
	type: string | null;
	priority: string | null;
	assignee: string | null;
	updatedAt: number | null;
	section: string | null;
}

// One request per URL per page load, shared by every card, the editor preview and the
// paste popover. A failed lookup is remembered as null so it isn't retried on each render.
const previews = new Map<string, Promise<LinkPreview | null>>();
// PROJ-1037: the settled values, so a re-render (the editor preview replaces its HTML on
// every keystroke) can put cards back synchronously, before paint, instead of flashing
// the plain link while an already-answered lookup resolves again.
const resolved = new Map<string, LinkPreview | null>();

/**
 * Same-origin URLs are sent as app paths (with any #fragment, which names a wiki
 * section): the API resolves those from its own data instead of fetching the app's HTML.
 */
export function previewRequestUrl(href: string, origin = window.location.origin): string {
	try {
		const url = new URL(href, origin);
		return url.origin === origin ? url.pathname + url.search + url.hash : url.href;
	} catch {
		return href;
	}
}

export function fetchLinkPreview(
	href: string,
	workspaceSlug?: string
): Promise<LinkPreview | null> {
	const target = previewRequestUrl(href);
	let pending = previews.get(target);
	if (!pending) {
		pending = apiFetch<LinkPreview>(`/api/link-preview?url=${encodeURIComponent(target)}`, {
			workspaceSlug,
		}).then(
			(p) => (p.title ? p : null),
			() => null
		);
		pending.then((p) => resolved.set(target, p));
		previews.set(target, pending);
	}
	return pending;
}

/** Test hook: forget every cached preview. */
export function clearLinkPreviewCache(): void {
	previews.clear();
	resolved.clear();
}

/**
 * Turn every `[data-link-card]` placeholder (see markdown.ts) inside `container` into a
 * preview card. Placeholders whose lookup fails keep their plain link. Built with DOM
 * APIs and textContent only — preview text comes from arbitrary third-party pages.
 *
 * Previews already fetched are applied synchronously, during this call; call it from a
 * layout effect to have them in place before the browser paints. `cachedOnly` stops there
 * and leaves the rest for a later call — the editor preview uses it on every keystroke, so
 * a half-typed URL is never looked up.
 */
export async function hydrateLinkCards(
	container: Element,
	workspaceSlug?: string,
	opts: { cachedOnly?: boolean } = {}
): Promise<void> {
	const nodes = [...container.querySelectorAll<HTMLElement>("[data-link-card]")].filter(
		(n) => !n.dataset.linkCardState
	);
	await Promise.all(
		nodes.map(async (node) => {
			const href = node.dataset.linkCard ?? "";
			// The attribute can also come from raw HTML in the markdown, which DOMPurify
			// passes through: only ever build a card around an http(s) link.
			if (!isHttpUrl(href)) {
				node.dataset.linkCardState = "plain";
				return;
			}
			const target = previewRequestUrl(href);
			if (resolved.has(target)) {
				apply(node, href, resolved.get(target) ?? null, workspaceSlug);
				return;
			}
			if (opts.cachedOnly) return;
			node.dataset.linkCardState = "loading";
			const preview = await fetchLinkPreview(href, workspaceSlug);
			if (node.isConnected) apply(node, href, preview, workspaceSlug);
		})
	);
}

function apply(
	node: HTMLElement,
	href: string,
	preview: LinkPreview | null,
	workspaceSlug: string | undefined
): void {
	if (!preview) {
		node.dataset.linkCardState = "plain";
		return;
	}
	node.replaceChildren(buildCard(href, preview, workspaceSlug));
	node.dataset.linkCardState = "card";
}

function isHttpUrl(href: string): boolean {
	try {
		return /^https?:$/.test(new URL(href, window.location.origin).protocol);
	} catch {
		return false;
	}
}

/**
 * The card image goes through the Worker (GET /api/link-preview/image), keyed by the
 * page URL, so the viewer's browser never contacts the linked site. An <img> can't send
 * X-Workspace-Slug, hence the `workspace` query parameter.
 */
export function previewImageSrc(preview: LinkPreview, workspaceSlug?: string): string {
	const ws = workspaceSlug ? `&workspace=${encodeURIComponent(workspaceSlug)}` : "";
	return `/api/link-preview/image?url=${encodeURIComponent(preview.url)}${ws}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string | null
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text) node.textContent = text;
	return node;
}

function metaLine(preview: LinkPreview): HTMLElement[] {
	const parts: HTMLElement[] = [];
	const add = (className: string, text: string | null, title?: string) => {
		if (!text) return;
		const span = el("span", className, text);
		if (title) span.title = title;
		parts.push(span);
	};
	add("link-card__ref", preview.ref);
	add("link-card__status", preview.status);
	add("link-card__site", preview.siteName);
	add("link-card__section", preview.section && `§ ${preview.section}`);
	add("link-card__detail", preview.type);
	add("link-card__detail", preview.priority && `${preview.priority} priority`);
	add("link-card__detail", preview.assignee, "Assignee");
	if (preview.kind === "wiki" && preview.updatedAt) {
		add("link-card__detail", `Updated ${relativeTime(preview.updatedAt)}`);
	}
	return parts;
}

function buildCard(
	href: string,
	preview: LinkPreview,
	workspaceSlug: string | undefined
): HTMLAnchorElement {
	const link = el("a", `link-card__link link-card__link--${preview.kind}`);
	link.href = href;
	if (preview.kind === "external") {
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	}
	const body = el("span", "link-card__body");
	const meta = metaLine(preview);
	if (meta.length) {
		const line = el("span", "link-card__meta");
		line.append(...meta);
		body.append(line);
	}
	body.append(el("span", "link-card__title", preview.title));
	if (preview.description) body.append(el("span", "link-card__desc", preview.description));
	link.append(body);
	if (preview.kind === "external" && preview.image) {
		const img = el("img", "link-card__image");
		img.src = previewImageSrc(preview, workspaceSlug);
		img.alt = "";
		img.loading = "lazy";
		img.addEventListener("error", () => img.remove());
		link.append(img);
	}
	return link;
}
