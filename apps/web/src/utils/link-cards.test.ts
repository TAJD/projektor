import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLinkPreviewCache, hydrateLinkCards, previewRequestUrl } from "./link-cards";
import { renderMd } from "./markdown";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const external = {
	url: "https://example.com/post",
	kind: "external",
	title: "A <b>post</b>",
	description: "About things",
	image: "https://example.com/card.png",
	siteName: "Example",
	ref: null,
	status: null,
	type: null,
	priority: null,
	assignee: null,
	updatedAt: null,
	section: null,
};

describe("previewRequestUrl", () => {
	it("sends same-origin links as app paths and others as absolute URLs", () => {
		expect(
			previewRequestUrl("https://app.test/projects/PROJ/issues/4/x?y=1", "https://app.test")
		).toBe("/projects/PROJ/issues/4/x?y=1");
		expect(previewRequestUrl("https://app.test/wiki/guide#install", "https://app.test")).toBe(
			"/wiki/guide#install"
		);
		expect(previewRequestUrl("https://example.com/a", "https://app.test")).toBe(
			"https://example.com/a"
		);
	});
});

describe("hydrateLinkCards", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		clearLinkPreviewCache();
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mount(markdown: string): HTMLElement {
		const div = document.createElement("div");
		div.innerHTML = renderMd(markdown);
		document.body.append(div);
		return div;
	}

	it("turns a bare-URL placeholder into a card, as text (never HTML)", async () => {
		fetchMock.mockResolvedValue(jsonResponse(external));
		const div = mount("https://example.com/post");
		await hydrateLinkCards(div);

		const card = div.querySelector<HTMLAnchorElement>("a.link-card__link");
		expect(card?.getAttribute("href")).toBe("https://example.com/post");
		expect(card?.querySelector(".link-card__title")?.textContent).toBe("A <b>post</b>");
		expect(card?.querySelector("b")).toBeNull();
		expect(card?.querySelector(".link-card__site")?.textContent).toBe("Example");
		// PROJ-1037: the image goes through the Worker, keyed by the page URL.
		expect(card?.querySelector("img")?.getAttribute("src")).toBe(
			`/api/link-preview/image?url=${encodeURIComponent("https://example.com/post")}`
		);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			`/api/link-preview?url=${encodeURIComponent("https://example.com/post")}`
		);
	});

	it("shows an issue's ref and status", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				...external,
				kind: "issue",
				title: "Fix it",
				image: null,
				siteName: null,
				ref: "PROJ-4",
				status: "In Progress",
			})
		);
		const div = mount(`${window.location.origin}/projects/PROJ/issues/4/fix-it`);
		await hydrateLinkCards(div);
		expect(div.querySelector(".link-card__ref")?.textContent).toBe("PROJ-4");
		expect(div.querySelector(".link-card__status")?.textContent).toBe("In Progress");
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			encodeURIComponent("/projects/PROJ/issues/4/fix-it")
		);
	});

	it("keeps the plain link when the preview has no title or the lookup fails", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ ...external, title: null }));
		const empty = mount("https://example.com/empty");
		await hydrateLinkCards(empty);
		expect(empty.querySelector(".link-card__link")).toBeNull();
		expect(empty.querySelector("a")?.getAttribute("href")).toBe("https://example.com/empty");

		fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 404));
		const missing = mount("https://example.com/missing");
		await hydrateLinkCards(missing);
		expect(missing.querySelector(".link-card__link")).toBeNull();
	});

	it("looks each URL up once", async () => {
		fetchMock.mockResolvedValue(jsonResponse(external));
		const div = mount("https://example.com/post\n\nhttps://example.com/post");
		await hydrateLinkCards(div);
		await hydrateLinkCards(div);
		expect(div.querySelectorAll(".link-card__link")).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("never builds a card around a non-http(s) placeholder from raw HTML", async () => {
		fetchMock.mockResolvedValue(jsonResponse(external));
		const div = mount('<div data-link-card="javascript:alert(1)">x</div>');
		await hydrateLinkCards(div);
		expect(div.querySelector(".link-card__link")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("passes the workspace to the image proxy, which an <img> can't send as a header", async () => {
		fetchMock.mockResolvedValue(jsonResponse(external));
		const div = mount("https://example.com/post");
		await hydrateLinkCards(div, "my ws");
		expect(div.querySelector("img")?.getAttribute("src")).toContain("&workspace=my%20ws");
	});

	it("shows a wiki card's section and last update", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				...external,
				kind: "wiki",
				title: "Guide",
				image: null,
				siteName: "Wiki",
				section: "Install steps",
				updatedAt: Math.floor(Date.now() / 1000) - 120,
			})
		);
		const div = mount(`${window.location.origin}/wiki/guide#install-steps`);
		await hydrateLinkCards(div);
		expect(div.querySelector(".link-card__section")?.textContent).toBe("§ Install steps");
		expect(div.querySelector(".link-card__detail")?.textContent).toBe("Updated 2m ago");
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			encodeURIComponent("/wiki/guide#install-steps")
		);
	});

	it("cachedOnly applies fetched previews synchronously and fetches nothing new", async () => {
		fetchMock.mockResolvedValue(jsonResponse(external));
		await hydrateLinkCards(mount("https://example.com/post"));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const again = mount("https://example.com/post\n\nhttps://example.com/new");
		void hydrateLinkCards(again, undefined, { cachedOnly: true });
		// Synchronously, before any await: the known URL is already a card.
		expect(again.querySelectorAll(".link-card__link")).toHaveLength(1);
		const unknown = again.querySelectorAll<HTMLElement>("[data-link-card]")[1];
		expect(unknown.dataset.linkCardState).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
