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
}

// One request per URL per page load, shared by every card, the editor preview and the
// paste popover. A failed lookup is remembered as null so it isn't retried on each render.
const previews = new Map<string, Promise<LinkPreview | null>>();

/**
 * Same-origin URLs are sent as app paths: the API resolves those from its own data
 * (issue/wiki previews) instead of fetching the app's own HTML.
 */
export function previewRequestUrl(href: string, origin = window.location.origin): string {
	try {
		const url = new URL(href, origin);
		return url.origin === origin ? url.pathname + url.search : url.href;
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
		previews.set(target, pending);
	}
	return pending;
}

/** Test hook: forget every cached preview. */
export function clearLinkPreviewCache(): void {
	previews.clear();
}

/**
 * Turn every `[data-link-card]` placeholder (see markdown.ts) inside `container` into a
 * preview card. Placeholders whose lookup fails keep their plain link. Built with DOM
 * APIs and textContent only — preview text comes from arbitrary third-party pages.
 */
export async function hydrateLinkCards(container: Element, workspaceSlug?: string): Promise<void> {
	const nodes = [...container.querySelectorAll<HTMLElement>("[data-link-card]")].filter(
		(n) => !n.dataset.linkCardState
	);
	await Promise.all(
		nodes.map(async (node) => {
			node.dataset.linkCardState = "loading";
			const href = node.dataset.linkCard ?? "";
			// The attribute can also come from raw HTML in the markdown, which DOMPurify
			// passes through: only ever build a card around an http(s) link.
			if (!isHttpUrl(href)) {
				node.dataset.linkCardState = "plain";
				return;
			}
			const preview = await fetchLinkPreview(href, workspaceSlug);
			if (!preview || !node.isConnected) {
				node.dataset.linkCardState = "plain";
				return;
			}
			node.replaceChildren(buildCard(href, preview));
			node.dataset.linkCardState = "card";
		})
	);
}

function isHttpUrl(href: string): boolean {
	try {
		return /^https?:$/.test(new URL(href, window.location.origin).protocol);
	} catch {
		return false;
	}
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

function buildCard(href: string, preview: LinkPreview): HTMLAnchorElement {
	const link = el("a", `link-card__link link-card__link--${preview.kind}`);
	link.href = href;
	if (preview.kind === "external") {
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	}
	const body = el("span", "link-card__body");
	const meta = el("span", "link-card__meta");
	if (preview.ref) meta.append(el("span", "link-card__ref", preview.ref));
	if (preview.status) meta.append(el("span", "link-card__status", preview.status));
	if (preview.siteName) meta.append(el("span", "link-card__site", preview.siteName));
	if (meta.childElementCount) body.append(meta);
	body.append(el("span", "link-card__title", preview.title));
	if (preview.description) body.append(el("span", "link-card__desc", preview.description));
	link.append(body);
	if (preview.image) {
		const img = el("img", "link-card__image");
		img.src = preview.image;
		img.alt = "";
		img.loading = "lazy";
		img.referrerPolicy = "no-referrer";
		img.addEventListener("error", () => img.remove());
		link.append(img);
	}
	return link;
}
