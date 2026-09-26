// WikiPage island — mock-fetch tests.
//
// WikiPage resolves its slug from (in order) the `slug` prop — how the /wiki/:slug
// astro routes render it (PROJ-487) — a `?slug=` query param (legacy), or the
// pathname (production's wiki/view.astro shell). It fetches the tree + page +
// revisions via apiFetch (which calls global fetch). The pattern: set the URL with
// history.replaceState, override the default stub from setup.ts with
// vi.stubGlobal, then await findBy* for the async state update.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetProjectStoreForTests } from "../lib/project-context";
import * as markdownUtils from "../utils/markdown";
import WikiPage, { assignHeadingIds, type ServerDraft, type WikiPageData } from "./WikiPage";

// PROJ-860/PROJ-803: real marked/DOMPurify rendering (so headings, mermaid placeholders
// etc. still show up in the DOM) wrapped in spies — `renderMdWithWikilinks`'s call count
// is how PROJ-860's "typing in sidebar search causes 0 markdown parses" is asserted, and
// `renderMermaidDiagrams` is mocked outright (PROJ-803's brief) since it dynamically
// imports the real `mermaid` package, which isn't worth exercising here.
vi.mock("../utils/markdown", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/markdown")>();
	return {
		...actual,
		renderMdWithWikilinks: vi.fn(actual.renderMdWithWikilinks),
		renderMermaidDiagrams: vi.fn().mockResolvedValue(undefined),
	};
});

const PAGE: WikiPageData = {
	id: "w1",
	slug: "my-page",
	title: "My Page",
	content: "Hello world content.",
	parent_id: null,
	updated_at: 1000,
	type: null,
	tags: [],
	status: null,
	verified_at: null,
	verified_by: null,
	owners: [],
	verify_interval: null,
	freshness: null,
};

function mockFetchWiki(
	page: WikiPageData | null,
	ok = true,
	status = 404,
	meEmail = "real-user@example.com"
) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ user: { id: "u1", email: meEmail, name: "User" } }),
				});
			}
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (!ok) {
				return Promise.resolve({ ok: false, status });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(page) });
		})
	);
}

function mockFetchMovePage(revisions: readonly unknown[] = []) {
	const otherPageNode = { id: "w2", slug: "other-page", title: "Other Page", children: [] };
	return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/revisions")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(revisions) });
		}
		if (u.includes("/tree")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve([otherPageNode]) });
		}
		if (init?.method === "PUT") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
	});
}

async function movePageToOther(fetchMock: ReturnType<typeof mockFetchMovePage>) {
	vi.stubGlobal("fetch", fetchMock);
	render(<WikiPage slug="my-page" />);
	await screen.findByText("My Page");

	fireEvent.click(screen.getByRole("button", { name: "Move" }));
	fireEvent.click(await screen.findByRole("combobox", { name: /new parent page/i }));
	fireEvent.click(await screen.findByRole("option", { name: "Other Page" }));
	const moveButtons = screen.getAllByRole("button", { name: "Move" });
	fireEvent.click(moveButtons[moveButtons.length - 1]);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
	vi.mocked(markdownUtils.renderMdWithWikilinks).mockClear();
	vi.mocked(markdownUtils.renderMermaidDiagrams).mockClear();
});

afterEach(() => {
	history.replaceState(null, "", "/");
	document.title = "";
	for (const el of document.head.querySelectorAll('meta[property^="og:"]')) el.remove();
});

describe("WikiPage", () => {
	it("shows 'Select a page' message when no slug in URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })
		);
		render(<WikiPage />);
		await waitFor(() => {
			expect(screen.getByText(/Select a page from the sidebar/i)).toBeTruthy();
		});
	});

	it("shows loading state while fetching the page", async () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<WikiPage slug="my-page" />);
		// Both the sidebar tree and the main content show "Loading…" while pending.
		// findAllByText waits for at least one match.
		const loadingEls = await screen.findAllByText("Loading…");
		expect(loadingEls.length).toBeGreaterThan(0);
	});

	it("renders page title and content after fetch resolves", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		expect(await screen.findByText("My Page")).toBeTruthy();
	});

	it("shows Edit button once the page is loaded", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
	});

	it("shows an error message when the page fetch fails (non-404)", async () => {
		mockFetchWiki(null, false, 500);
		render(<WikiPage slug="my-page" />);
		expect(await screen.findByText(/Failed to load page/i)).toBeTruthy();
	});

	it("shows a 404 message when the slug resolves to nothing (PROJ-487)", async () => {
		mockFetchWiki(null, false, 404);
		render(<WikiPage slug="does-not-exist" />);
		expect(await screen.findByText(/No wiki page found at "does-not-exist"/i)).toBeTruthy();
	});

	it("shows Move button once the page is loaded", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
	});

	it("moves a page to a new parent via PUT and refetches tree/page", async () => {
		const fetchMock = mockFetchMovePage();
		await movePageToOther(fetchMock);

		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(putCall?.[0]).toContain("/api/wiki/my-page");
			expect(JSON.parse(putCall?.[1].body)).toEqual({ parentId: "w2" });
		});
	});
});

describe("WikiPage — public read-only demo viewer (PROJ-580)", () => {
	it("hides all write affordances for the public viewer", async () => {
		mockFetchWiki(PAGE, true, 404, "public-viewer@projektor.local");
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "+ Child page" })).toBeNull();
		});

		expect(screen.queryByRole("button", { name: "+ New page" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Attach file/i })).toBeNull();
	});

	it("shows write affordances for a real user", async () => {
		mockFetchWiki(PAGE, true, 404, "real-user@example.com");
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(await screen.findByRole("button", { name: "+ New page" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ Child page" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Attach file/i })).toBeTruthy();
	});
});

// PROJ-487: path-based /wiki/:slug routing + client-set SSR-shell metadata (static
// output has no per-request server render, see AGENTS.md — this is the closest
// equivalent) + legacy ?slug= redirect.
describe("WikiPage — path-based routing (PROJ-487)", () => {
	const realLocation = window.location;

	afterEach(() => {
		Object.defineProperty(window, "location", { configurable: true, value: realLocation });
	});

	// jsdom's Location.prototype.replace is a non-configurable, non-writable own data
	// property, so neither vi.spyOn nor a direct assignment (nor a Proxy — it trips the
	// "must return the target's actual value" invariant for such properties) can shadow
	// it. Swap `window.location` for an unrelated plain object instead (only the fields
	// the code under test reads), restored in afterEach above.
	function stubLocationReplace() {
		const replace = vi.fn();
		Object.defineProperty(window, "location", {
			configurable: true,
			value: {
				pathname: realLocation.pathname,
				search: realLocation.search,
				origin: realLocation.origin,
				hostname: realLocation.hostname,
				host: realLocation.host,
				replace,
			},
		});
		return replace;
	}

	it("resolves the slug from the URL path when no slug prop is given (production wiki/view.astro shell)", async () => {
		history.replaceState(null, "", "/wiki/my-page");
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		expect(await screen.findByText("My Page")).toBeTruthy();
	});

	it("sets document title and OG meta tags from the fetched page", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(document.title).toBe("My Page — Projektor Wiki");
		});
		expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
			"My Page"
		);
		expect(
			document.head.querySelector('meta[property="og:description"]')?.getAttribute("content")
		).toContain("Hello world content");
		expect(
			document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")
		).toContain("/wiki/my-page");
	});

	it("redirects a legacy ?slug= query URL to the canonical /wiki/:slug path", async () => {
		history.replaceState(null, "", "/wiki?slug=my-page");
		const replace = stubLocationReplace();
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith("/wiki/my-page");
		});
	});

	it("redirects to the current canonical slug, not the requested one (no redirect chain, PROJ-483)", async () => {
		// The old/renamed slug was requested (e.g. via a stale bookmark that hit the
		// Worker's pretty-URL fallback), but the API's live-then-redirect lookup
		// resolved it to the page's current slug.
		const replace = stubLocationReplace();
		mockFetchWiki({ ...PAGE, slug: "new-slug" });
		render(<WikiPage slug="old-slug" />);
		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith("/wiki/new-slug");
		});
	});

	it("does not redirect once already on the canonical path", async () => {
		history.replaceState(null, "", "/wiki/my-page");
		const replace = stubLocationReplace();
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		expect(replace).not.toHaveBeenCalled();
	});

	// PROJ-512: a malformed percent-escape in the pathname (e.g. a bare "%" not followed
	// by two hex digits) made decodeURIComponent throw inside slugFromPathname, crashing
	// the island instead of falling back to "no slug".
	it("does not crash on a malformed percent-escape in the URL path", async () => {
		history.replaceState(null, "", "/wiki/100%");
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		await waitFor(() => {
			expect(screen.getByText(/Select a page from the sidebar/i)).toBeTruthy();
		});
	});
});

describe("WikiPage — project scope control (PROJ-352, PROJ-742)", () => {
	let requestedUrls: string[] = [];

	function mockFetchWikiWithProjects(page: WikiPageData | null) {
		requestedUrls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				requestedUrls.push(u);
				if (u.includes("/revisions")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				if (u.includes("/tree")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				if (u.includes("/api/projects")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([{ id: "p1", key: "PROJ", name: "Projektor" }]),
					});
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve(page) });
			})
		);
	}

	beforeEach(() => {
		__resetProjectStoreForTests();
		localStorage.clear();
		history.replaceState(null, "", "/");
	});

	it("scopes to the resolved current project when no scope is set in the URL", async () => {
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
				/PROJ — Projektor/i
			);
		});
	});

	it("shows the project's scope when projectId is set via the URL", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
				/PROJ — Projektor/i
			);
		});
	});

	it("fetches the tree scoped to the project, including workspace-level pages", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			const treeUrl = requestedUrls.find((u) => u.includes("/api/wiki/tree"));
			expect(treeUrl).toBeTruthy();
			expect(treeUrl).toContain("projectId=p1");
			expect(treeUrl).toContain("includeWorkspacePages=1");
		});
	});

	it("never fetches the tree unscoped before the project resolves", async () => {
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(requestedUrls.some((u) => u.includes("/api/wiki/tree"))).toBe(true);
		});
		for (const u of requestedUrls.filter((x) => x.includes("/api/wiki/tree"))) {
			expect(u).toContain("projectId=p1");
		}
	});

	it("honours ?scope=workspace as the explicit all-projects opt-out", async () => {
		history.replaceState(null, "", "?scope=workspace");
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
			/Workspace \(all projects\)/i
		);
		await waitFor(() => {
			const treeUrl = requestedUrls.find((u) => u.includes("/api/wiki/tree"));
			expect(treeUrl).toBeTruthy();
			expect(treeUrl).not.toContain("projectId=");
		});
	});
});

// PROJ-495: mock fetch backing a fake server-side wiki_drafts row — GET/PUT/DELETE
// .../wiki/:slug/draft, plus the usual tree/revisions/page fixtures. `draftCalls`
// records every draft PUT body for assertions.
function mockFetchWikiWithDraft(initialDraft: ServerDraft | null = null) {
	let draft = initialDraft;
	const draftPutCalls: ServerDraft[] = [];
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/draft")) {
			if (init?.method === "PUT") {
				const body = JSON.parse(init.body as string) as {
					title: string;
					content: string;
					baseRevisionId: string | null;
				};
				draft = { ...body, updatedAt: 2_000_000 };
				draftPutCalls.push(draft);
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
			}
			if (init?.method === "DELETE") {
				draft = null;
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(draft) });
		}
		if (u.includes("/revisions")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		}
		if (u.includes("/tree")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		}
		if (init?.method === "PUT") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, draftPutCalls };
}

async function startEditingWithTitleInput(): Promise<HTMLInputElement> {
	mockFetchWikiWithDraft();
	render(<WikiPage slug="my-page" />);
	await screen.findByText("My Page");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	await vi.advanceTimersByTimeAsync(0);
	return screen.getByLabelText("Page title") as HTMLInputElement;
}

async function renderWithDraftAndOpenEdit(draft: ServerDraft) {
	mockFetchWikiWithDraft(draft);
	render(<WikiPage slug="my-page" />);
	await screen.findByText("My Page");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	await vi.advanceTimersByTimeAsync(0);
}

describe("server-side draft autosave (PROJ-495)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("PUTs a draft to the server after debounce while editing", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });

		await vi.advanceTimersByTimeAsync(1000);

		const fetchMock = vi.mocked(fetch);
		const putCall = fetchMock.mock.calls.find(
			([url, init]) => String(url).includes("/draft") && (init as RequestInit)?.method === "PUT"
		);
		expect(putCall).toBeTruthy();
		const body = JSON.parse((putCall?.[1] as RequestInit | undefined)?.body as string);
		expect(body.title).toBe("My Page Edited");
		expect(body.content).toBe(PAGE.content);
	});

	it("clears the server draft after a successful save", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(1000);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await vi.advanceTimersByTimeAsync(0);

		const fetchMock = vi.mocked(fetch);
		await waitFor(() => {
			const deleteCall = fetchMock.mock.calls.find(
				([url, init]) =>
					String(url).includes("/draft") && (init as RequestInit)?.method === "DELETE"
			);
			expect(deleteCall).toBeTruthy();
		});
	});

	it("does not discard the draft when editing is cancelled", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(1000);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await vi.advanceTimersByTimeAsync(0);

		const fetchMock = vi.mocked(fetch);
		const deleteCall = fetchMock.mock.calls.find(
			([url, init]) => String(url).includes("/draft") && (init as RequestInit)?.method === "DELETE"
		);
		expect(deleteCall).toBeFalsy();
	});

	it("flushes unflushed edits to the server draft when leaving edit mode via navigation", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "Typed just before navigating away" } });

		// Navigate away (e.g. clicking a sidebar link) before the 1s debounce fires.
		fireEvent.click(screen.getByRole("button", { name: "+ New page" }));
		await vi.advanceTimersByTimeAsync(0);

		const fetchMock = vi.mocked(fetch);
		const putCall = fetchMock.mock.calls.find(
			([url, init]) => String(url).includes("/draft") && (init as RequestInit)?.method === "PUT"
		);
		expect(putCall).toBeTruthy();
		const body = JSON.parse((putCall?.[1] as RequestInit | undefined)?.body as string);
		expect(body.title).toBe("Typed just before navigating away");
	});
});

const isDraftCall = (method: string) => (call: unknown[]) =>
	String(call[0]).includes("/draft") && (call[1] as RequestInit | undefined)?.method === method;

describe("draft autosave only writes real changes (PROJ-799)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opening edit and waiting writes no draft", async () => {
		await startEditingWithTitleInput();
		await vi.advanceTimersByTimeAsync(3000);
		const fetchMock = vi.mocked(fetch);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);
	});

	it("opening edit and cancelling without changes writes no draft", async () => {
		await startEditingWithTitleInput();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await vi.advanceTimersByTimeAsync(2000);
		const fetchMock = vi.mocked(fetch);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);
		expect(fetchMock.mock.calls.filter(isDraftCall("DELETE"))).toEqual([]);
	});

	it("reverting to the published text deletes the draft this session wrote", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(1000);
		const fetchMock = vi.mocked(fetch);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toHaveLength(1);

		fireEvent.input(titleInput, { target: { value: PAGE.title } });
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(isDraftCall("DELETE"))).toHaveLength(1);
	});

	it("a failed draft check disables autosave and warns", async () => {
		const { fetchMock } = mockFetchWikiWithDraft();
		const base = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => unknown;
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/draft") && (init?.method ?? "GET") === "GET") {
				return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
			}
			return base(url, init);
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await vi.advanceTimersByTimeAsync(0);

		expect(await screen.findByText(/autosave is off for this edit/i)).toBeTruthy();
		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		fireEvent.input(titleInput, { target: { value: "Would clobber another device" } });
		await vi.advanceTimersByTimeAsync(3000);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);
	});

	it("does not autosave while the draft check is still loading", async () => {
		const { fetchMock } = mockFetchWikiWithDraft();
		const base = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => unknown;
		let resolveDraft: (v: unknown) => void = () => {};
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (String(url).includes("/draft") && (init?.method ?? "GET") === "GET") {
				return new Promise((r) => {
					resolveDraft = r;
				});
			}
			return base(url, init);
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await vi.advanceTimersByTimeAsync(0);
		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		fireEvent.input(titleInput, { target: { value: "Typed before the draft loaded" } });
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);

		resolveDraft({ ok: true, json: () => Promise.resolve(null) });
		// Preact runs effects after paint, so give the debounce room past 1s.
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toHaveLength(1);
	});

	it("never re-creates the draft while a save is in flight or after it succeeds", async () => {
		const { fetchMock } = mockFetchWikiWithDraft();
		const base = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => unknown;
		let releaseSave: () => void = () => {};
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (init?.method === "PUT" && !u.includes("/draft")) {
				return new Promise((r) => {
					releaseSave = () => r({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
				});
			}
			return base(url, init);
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await vi.advanceTimersByTimeAsync(0);
		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(500);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);

		releaseSave();
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toEqual([]);
		expect(fetchMock.mock.calls.filter(isDraftCall("DELETE"))).toHaveLength(1);
	});
});

describe("leaving mid-edit keeps the last keystrokes (PROJ-800)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("navigating to another page flushes the pending draft before clearing the page", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "Typed right before leaving" } });

		// Back/forward (and sidebar links) go through showSlug, which clears page state.
		history.pushState(null, "", "/wiki/other-page");
		window.dispatchEvent(new PopStateEvent("popstate"));
		await vi.advanceTimersByTimeAsync(0);

		const fetchMock = vi.mocked(fetch);
		const puts = fetchMock.mock.calls.filter(isDraftCall("PUT"));
		expect(puts).toHaveLength(1);
		expect(String(puts[0][0])).toContain("/api/wiki/my-page/draft");
		const body = JSON.parse((puts[0][1] as RequestInit).body as string);
		expect(body.title).toBe("Typed right before leaving");

		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchMock.mock.calls.filter(isDraftCall("PUT"))).toHaveLength(1);
	});

	it("prompts before unload only while there are unsaved changes", async () => {
		const titleInput = await startEditingWithTitleInput();
		const fire = () => {
			const e = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(e);
			return e.defaultPrevented;
		};
		expect(fire()).toBe(false);

		fireEvent.input(titleInput, { target: { value: "Unsaved" } });
		await vi.advanceTimersByTimeAsync(0);
		expect(fire()).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(fire()).toBe(false);
	});
});

describe("server-side draft autosave (PROJ-495) — restore banner", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a restore banner when a newer draft exists on startEdit", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			baseRevisionId: null,
			updatedAt: 2_000_000,
		});
		expect(await screen.findByText(/Restore unsaved draft from/i)).toBeTruthy();
	});

	it("restore populates the fields from the draft and dismisses the banner", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			baseRevisionId: null,
			updatedAt: 2_000_000,
		});
		await screen.findByText(/Restore unsaved draft from/i);
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));

		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		expect(titleInput.value).toBe("Draft Title");
		expect(screen.queryByText(/Restore unsaved draft from/i)).toBeNull();
	});

	it("discard clears the server draft and falls through to loading from the page", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			baseRevisionId: null,
			updatedAt: 2_000_000,
		});
		await screen.findByText(/Restore unsaved draft from/i);
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		await vi.advanceTimersByTimeAsync(0);

		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		expect(titleInput.value).toBe(PAGE.title);
		const fetchMock = vi.mocked(fetch);
		const deleteCall = fetchMock.mock.calls.find(
			([url, init]) => String(url).includes("/draft") && (init as RequestInit)?.method === "DELETE"
		);
		expect(deleteCall).toBeTruthy();
	});

	// PROJ-797: timestamp order no longer decides (an older-but-different draft IS
	// offered — see the PROJ-797 tests); a draft identical to the published page isn't.
	it("does not offer a draft that matches the published page", async () => {
		await renderWithDraftAndOpenEdit({
			title: PAGE.title,
			content: PAGE.content,
			baseRevisionId: null,
			updatedAt: PAGE.updated_at - 1,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByText(/Restore unsaved draft from/i)).toBeNull();
	});
});

// PROJ-507: PROJ-484 added optimistic locking to PUT /api/wiki/:slug (an optional
// baseRevisionId that must match the page's current latest revision, else a 409), but
// the save path here never sent it — silently defeating the whole feature. These
// tests cover that the loaded revision id is now sent, and that a 409 is surfaced
// rather than swallowed.
describe("optimistic locking (PROJ-507)", () => {
	const REVISION = { id: "rev-1", author_id: "u1", author_name: "Ann", created_at: 500 };

	function mockFetchWikiWithRevision(putResponse: Readonly<{ ok: boolean; status?: number }>) {
		return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([REVISION]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "PUT") {
				return putResponse.ok
					? Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) })
					: Promise.resolve({ ok: false, status: putResponse.status });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
	}

	it("sends the loaded revision's id as baseRevisionId on save", async () => {
		const fetchMock = mockFetchWikiWithRevision({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(JSON.parse(putCall?.[1].body)).toMatchObject({ baseRevisionId: "rev-1" });
		});
	});

	it("sends baseRevisionId: null when the page has never been revised", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "PUT") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(JSON.parse(putCall?.[1].body)).toMatchObject({ baseRevisionId: null });
		});
	});

	it("surfaces a conflict message instead of silently clobbering on a 409", async () => {
		const fetchMock = mockFetchWikiWithRevision({ ok: false, status: 409 });
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(/changed by someone else/i)).toBeTruthy();
		// Still in edit mode — the save was rejected, not applied.
		expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
	});

	it("reports an unrelated failure generically even when the slug contains 409", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([REVISION]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "PUT") {
				return Promise.resolve({ ok: false, status: 500 });
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ ...PAGE, slug: "proj-409-notes" }),
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="proj-409-notes" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(/Save failed/i)).toBeTruthy();
		expect(screen.queryByText(/changed by someone else/i)).toBeNull();
	});

	// Sending `null` for "we haven't loaded the revisions yet" would assert the page has
	// never been revised, and the server would reject every save on an already-revised
	// page as a conflict. Omit the field instead.
	it("omits baseRevisionId when the revision list hasn't loaded yet", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return new Promise(() => {});
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "PUT") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(Object.keys(JSON.parse(putCall?.[1].body))).not.toContain("baseRevisionId");
		});
		// Let the post-save refetches settle so they don't render after teardown.
		await screen.findByRole("button", { name: "Edit" });
	});

	// A move refetches the page; the revision list must survive that, or the next save
	// looks like an unrevised page and gets rejected as a conflict.
	it("still sends baseRevisionId after a move has refreshed the page", async () => {
		const fetchMock = mockFetchMovePage([REVISION]);
		await movePageToOther(fetchMock);
		// The move's page refetch is what used to wipe the revision list — wait for it to
		// land before editing, or the test races past the bug.
		await waitFor(() => {
			const pageGets = fetchMock.mock.calls.filter(
				([u, init]) => init?.method !== "PUT" && String(u).endsWith("/api/wiki/my-page")
			);
			expect(pageGets).toHaveLength(2);
		});

		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
			expect(puts).toHaveLength(2);
			expect(JSON.parse(puts[1][1].body)).toMatchObject({ baseRevisionId: "rev-1" });
		});
		// Let the post-save refetches settle so they don't render after teardown.
		await screen.findByRole("button", { name: "Edit" });
	});
});

// PROJ-488 (R6): frontmatter metadata header card, tag chips, and sidebar tag/type/
// status filters.
describe("WikiPage frontmatter metadata (PROJ-488)", () => {
	const PAGE_WITH_META: WikiPageData = {
		...PAGE,
		type: "runbook",
		tags: ["ops", "oncall"],
		status: "current",
		verified_at: 1_700_000_000,
		verified_by: "alice@example.com",
		owners: ["alice", "bob"],
		verify_interval: 90,
	};

	it("renders a metadata card with type, status, tags, and owners", async () => {
		mockFetchWiki(PAGE_WITH_META);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.getByText("runbook")).toBeTruthy();
		expect(screen.getByText("current")).toBeTruthy();
		expect(screen.getByText("ops")).toBeTruthy();
		expect(screen.getByText("oncall")).toBeTruthy();
		expect(screen.getByText(/Owners: alice, bob/)).toBeTruthy();
		expect(screen.getByText(/Verified/)).toBeTruthy();
	});

	it("does not render the raw frontmatter block in the page body", async () => {
		mockFetchWiki({
			...PAGE_WITH_META,
			content: [
				"---",
				"type: runbook",
				"tags: [ops, oncall]",
				"status: current",
				"---",
				"# Real heading",
				"",
				"Body text.",
			].join("\n"),
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(await screen.findByText("Body text.")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Real heading" })).toBeTruthy();
		// The YAML would otherwise render as a setext <h2> at the top of the body.
		expect(screen.queryByText(/type: runbook/)).toBeNull();
		expect(screen.queryByText(/status: current/)).toBeNull();
	});

	it("renders no metadata card for a page without frontmatter", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.queryByText(/Owners:/)).toBeNull();
		expect(screen.queryByText(/Verified/)).toBeNull();
	});

	it("filtering by tags in the sidebar fetches and lists matching pages", async () => {
		const FILTERED_RESULT = [
			{
				id: "w9",
				slug: "ops-runbook",
				title: "Ops Runbook",
				type: "runbook",
				status: "current",
				tags: ["ops"],
			},
		];
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/api/wiki?") && u.includes("tags=")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(FILTERED_RESULT) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.input(screen.getByLabelText(/Filter wiki pages by tags/i), {
			target: { value: "ops" },
		});

		expect(await screen.findByText("Ops Runbook")).toBeTruthy();
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([u]) => String(u).includes("/api/wiki?") && String(u).includes("tags=ops")
				)
			).toBe(true);
		});
	});
});

describe("WikiPage sidebar type filter — freeform types (PROJ-514)", () => {
	it("offers a workspace-discovered type alongside the well-known ones, and filters by it", async () => {
		// PROJ-514: type discovery now comes from the tree fetch (getWikiTree selects
		// `type`), not a second unfiltered listWikiPages call — see WikiPage.tsx buildTypeFilterOptions.
		const TREE = [
			{ id: "w1", slug: "my-page", title: "My Page Tree Node", type: null, children: [] },
			{ id: "w9", slug: "product-brief", title: "Product Brief", type: "whitepaper", children: [] },
		];
		const FILTERED_RESULT = [
			{
				id: "w9",
				slug: "product-brief",
				title: "Product Brief",
				type: "whitepaper",
				status: null,
				tags: [],
			},
		];
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(TREE) });
			}
			if (u.includes("/api/wiki?") && u.includes("type=whitepaper")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(FILTERED_RESULT) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(await screen.findByRole("combobox", { name: "Filter wiki pages by type" }));
		fireEvent.click(await screen.findByRole("option", { name: "whitepaper" }));

		expect(await screen.findByText("Product Brief")).toBeTruthy();
		await waitFor(() => {
			expect(fetchMock.mock.calls.some(([u]) => String(u).includes("type=whitepaper"))).toBe(true);
		});
	});

	it("still offers the well-known types when the workspace has no other distinct types", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(await screen.findByRole("combobox", { name: "Filter wiki pages by type" }));
		expect(screen.getByRole("option", { name: "Runbook" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "ADR" })).toBeTruthy();
	});

	it("dedupes a case-variant freeform type against its well-known match instead of listing both", async () => {
		const TREE = [
			{ id: "w1", slug: "my-page", title: "My Page Tree Node", type: "Runbook", children: [] },
		];
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(TREE) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(await screen.findByRole("combobox", { name: "Filter wiki pages by type" }));
		expect(screen.getAllByRole("option", { name: "Runbook" })).toHaveLength(1);
	});
});

// PROJ-489 (R7): Verify button + computed staleness badge in the metadata header card.
describe("WikiPage freshness model (PROJ-489)", () => {
	const STALE_PAGE: WikiPageData = {
		...PAGE,
		verify_interval: 30,
		verified_at: 1_000_000,
		freshness: { state: "stale", staleSince: 1_000_000 + 30 * 86400 },
	};

	const FRESH_PAGE: WikiPageData = {
		...PAGE,
		verify_interval: 365,
		verified_at: 1_000_000,
		freshness: { state: "fresh", staleSince: null },
	};

	it("renders a Verify button and a Stale badge for a computed-stale page", async () => {
		mockFetchWiki(STALE_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
		expect(screen.getByText("Stale")).toBeTruthy();
	});

	it("does not render a staleness badge for a fresh page", async () => {
		mockFetchWiki(FRESH_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
		expect(screen.queryByText("Stale")).toBeNull();
		expect(screen.queryByText("Unverified")).toBeNull();
	});

	it("renders no Verify button for a page with no verification signal at all", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
	});

	it("clicking Verify POSTs to /verify and refetches the page", async () => {
		let verifyCalled = false;
		const verifiedPage: WikiPageData = {
			...STALE_PAGE,
			verified_at: 2_000_000,
			verified_by: "me@example.com",
			freshness: { state: "fresh", staleSince: null },
		};
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/verify") && init?.method === "POST") {
				verifyCalled = true;
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							ok: true,
							verifiedAt: 2_000_000,
							verifiedBy: "me@example.com",
							freshness: { state: "fresh", staleSince: null },
						}),
				});
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(verifyCalled ? verifiedPage : STALE_PAGE),
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Verify" }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([u, init]) => String(u).includes("/verify") && init?.method === "POST"
				)
			).toBe(true);
		});
		await waitFor(() => {
			expect(screen.queryByText("Stale")).toBeNull();
		});
	});

	it("renders a staleness badge in search results for a stale match", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/api/wiki/search")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve([
							{
								id: "w2",
								slug: "stale-runbook",
								title: "Stale Runbook",
								project_id: null,
								excerpt: null,
								type: null,
								status: null,
								tags: [],
								freshness: { state: "stale", staleSince: 123 },
							},
						]),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.input(screen.getByLabelText(/Search wiki pages/i), {
			target: { value: "runbook" },
		});

		expect(await screen.findByText("Stale Runbook")).toBeTruthy();
		expect(screen.getByText("Stale")).toBeTruthy();
	});
});

// PROJ-491 (R9): the create-form's template picker, sourced from GET /api/wiki/templates.
describe("WikiPage — create page template picker (PROJ-491)", () => {
	const TEMPLATES = [
		{
			id: "t1",
			slug: "runbook-template",
			title: "Runbook Template",
			url: "/wiki/runbook-template",
		},
	];

	function mockFetchWithTemplates(postSpy?: (url: string, body: unknown) => void) {
		return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/templates")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(TEMPLATES) });
			}
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "POST" && postSpy) {
				postSpy(u, init.body ? JSON.parse(String(init.body)) : undefined);
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ id: "new1", slug: "new-page" }),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		});
	}

	it("shows a template picker populated from list_wiki_templates", async () => {
		vi.stubGlobal("fetch", mockFetchWithTemplates());
		render(<WikiPage />);
		fireEvent.click(await screen.findByRole("button", { name: "+ New page" }));

		fireEvent.click(await screen.findByRole("combobox", { name: /Seed content from template/i }));
		expect(await screen.findByRole("option", { name: "Runbook Template" })).toBeTruthy();
	});

	it("selecting a template hides the content editor and sends templateSlug instead of content", async () => {
		const postSpy = vi.fn();
		vi.stubGlobal("fetch", mockFetchWithTemplates(postSpy));
		render(<WikiPage />);
		fireEvent.click(await screen.findByRole("button", { name: "+ New page" }));

		fireEvent.click(await screen.findByRole("combobox", { name: /Seed content from template/i }));
		fireEvent.click(await screen.findByRole("option", { name: "Runbook Template" }));

		expect(await screen.findByText(/seeded from the "Runbook Template" template/i)).toBeTruthy();

		fireEvent.input(screen.getByRole("textbox", { name: /title/i }), {
			target: { value: "Deploy Runbook" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create page" }));

		await waitFor(() => {
			expect(postSpy).toHaveBeenCalled();
		});
		const [, body] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
		expect(body.templateSlug).toBe("runbook-template");
		expect(body.content).toBeUndefined();
	});

	it("no template picker is rendered when there are no templates", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				if (u.includes("/templates")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			})
		);
		render(<WikiPage />);
		fireEvent.click(await screen.findByRole("button", { name: "+ New page" }));

		await screen.findByRole("textbox", { name: /title/i });
		expect(screen.queryByRole("combobox", { name: /Seed content from template/i })).toBeNull();
	});
});

// PROJ-492 (R10): revision diff view + one-click restore.
describe("revision history: diff view + restore (PROJ-492)", () => {
	const REVISION_WITH_SUMMARY = {
		id: "rev-old",
		author_id: "u1",
		author_name: "Ann",
		created_at: 500,
		summary: "Fixed a typo",
	};

	function mockFetchWithRevision(
		opts: Readonly<{
			diff?: { from: string; to: string; diff: string };
			oldRevisionContent?: string;
			putResponse?: { ok: boolean; status?: number };
		}>
	) {
		return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/diff")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve(
							opts.diff ?? { from: "rev-old", to: "current", diff: "-old line\n+new line" }
						),
				});
			}
			if (/\/revisions\/rev-old$/.test(u)) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							...REVISION_WITH_SUMMARY,
							content: opts.oldRevisionContent ?? "old content",
						}),
				});
			}
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([REVISION_WITH_SUMMARY]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (init?.method === "PUT") {
				const putResponse = opts.putResponse ?? { ok: true };
				return putResponse.ok
					? Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) })
					: Promise.resolve({ ok: false, status: putResponse.status });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
	}

	it("shows the revision's summary in the history list", async () => {
		vi.stubGlobal("fetch", mockFetchWithRevision({}));
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: /History/i }));
		expect(await screen.findByText("Fixed a typo")).toBeTruthy();
	});

	it("fetches and renders the diff against current when 'Diff vs current' is clicked", async () => {
		vi.stubGlobal("fetch", mockFetchWithRevision({}));
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: /History/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Diff vs current" }));

		expect(await screen.findByText("-old line")).toBeTruthy();
		expect(screen.getByText("+new line")).toBeTruthy();
	});

	it("restore re-submits the old revision's content through update_wiki_page and refreshes the page", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const fetchMock = mockFetchWithRevision({ oldRevisionContent: "the original content" });
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: /History/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(JSON.parse(putCall?.[1].body)).toMatchObject({
				content: "the original content",
				baseRevisionId: "rev-old",
			});
		});
	});

	it("does not restore when the confirm dialog is dismissed", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(false);
		const fetchMock = mockFetchWithRevision({});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: /History/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

		expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
	});

	it("surfaces a distinct message when the page changed since history was loaded (409)", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
		vi.stubGlobal("fetch", mockFetchWithRevision({ putResponse: { ok: false, status: 409 } }));
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: /History/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

		await waitFor(() => {
			expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("changed by someone else"));
		});
	});
});

// PROJ-494: inline image paste/drag upload + attachment referenced/orphaned badge.
describe("WikiPage — inline images & attachment badges (PROJ-494)", () => {
	const REFERENCED_ID = "att-referenced";
	const ORPHAN_ID = "att-orphan";
	const PAGE_WITH_IMAGE = {
		...PAGE,
		content: `See ![screenshot](/api/files/${REFERENCED_ID}?workspace=acme) here.`,
	};
	const ATTACHMENTS = [
		{
			id: REFERENCED_ID,
			filename: "screenshot.png",
			contentType: "image/png",
			size: 1024,
			createdAt: 1,
		},
		{ id: ORPHAN_ID, filename: "old.txt", contentType: "text/plain", size: 512, createdAt: 2 },
	];

	function mockFetchWithAttachments(uploadSpy?: (form: FormData) => void) {
		return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/api/files")) {
				if (init?.method === "POST") {
					uploadSpy?.(init.body as FormData);
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "att-new" }) });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve(ATTACHMENTS) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE_WITH_IMAGE) });
		});
	}

	it("badges an attachment referenced in the page content as 'In page'", async () => {
		vi.stubGlobal("fetch", mockFetchWithAttachments());
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		await screen.findByText("screenshot.png");
		const referencedRow = screen.getByText("screenshot.png").closest("div");
		expect(referencedRow?.textContent).toContain("In page");
	});

	it("badges an attachment not referenced in the content as 'Unreferenced'", async () => {
		vi.stubGlobal("fetch", mockFetchWithAttachments());
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		await screen.findByText("old.txt");
		const orphanRow = screen.getByText("old.txt").closest("div");
		expect(orphanRow?.textContent).toContain("Unreferenced");
	});

	it("uploads a pasted image via the existing attachment endpoint and inserts a markdown ref", async () => {
		const uploadSpy = vi.fn();
		const fetchMock = mockFetchWithAttachments(uploadSpy);
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		const content = await waitFor(() => {
			const el = document.querySelector(".cm-content");
			if (!el) throw new Error("cm-content not found");
			return el as HTMLElement;
		});

		const file = new File(["fake"], "pasted.png", { type: "image/png" });
		const clipboardData = {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			files: [file],
			getData: () => "",
		};
		fireEvent.paste(content, { clipboardData });

		await waitFor(() => expect(uploadSpy).toHaveBeenCalled());
		const form = uploadSpy.mock.calls[0][0] as FormData;
		expect(form.get("entityType")).toBe("wiki_page");
		expect(form.get("entityId")).toBe(PAGE.id);
	});
});

describe("WikiPage — wide table scroll boundary (PROJ-612)", () => {
	it("gives the .table-scroll wrapper around a rendered table its own horizontal scroll boundary", async () => {
		const PAGE_WITH_TABLE = {
			...PAGE,
			content: "| Column A | Column B |\n| --- | --- |\n| a | b |\n",
		};
		mockFetchWiki(PAGE_WITH_TABLE);
		render(<WikiPage slug="my-page" />);

		// renderMdWithWikilinks (markdown.ts) wraps every rendered <table> in a
		// .table-scroll div (PROJ-605) — the scroll boundary belongs on that
		// wrapper, not the table itself.
		const table = await screen.findByRole("table");
		expect(table.parentElement?.className).toBe("table-scroll");

		const styleTags = Array.from(document.querySelectorAll("style"));
		const rule = styleTags
			.map((s) => s.textContent)
			.find((css) => css?.includes(".prose .table-scroll"));
		expect(rule).toBeTruthy();
		expect(rule).toContain("overflow-x: auto");
	});
});

// PROJ-664: at ≤640px the page-tree sidebar becomes an off-canvas drawer and the
// action row collapses [+ Child page]/[Move]/[Delete] behind a "More page
// actions" menu, keeping only Edit inline. matchMedia is stubbed to matches:true
// only for the "(max-width: 640px)" query, matching setup.ts's default mock
// shape (matches: false) everywhere else so unrelated hooks (e.g. dark-mode
// detection) are unaffected.
function mockMobileViewport() {
	const original = window.matchMedia;
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: query === "(max-width: 640px)",
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	})) as unknown as typeof window.matchMedia;
	return () => {
		window.matchMedia = original;
	};
}

describe("WikiPage — mobile drawer + action overflow (PROJ-664)", () => {
	it("collapses the page action row to Edit + a 'More page actions' menu on mobile", async () => {
		const restore = mockMobileViewport();
		try {
			mockFetchWiki(PAGE);
			render(<WikiPage slug="my-page" />);
			await screen.findByText("My Page");

			expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
			expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
			expect(screen.queryByRole("button", { name: "+ Child page" })).toBeNull();

			const overflowTrigger = screen.getByRole("button", { name: "More page actions" });
			fireEvent.click(overflowTrigger);

			expect(await screen.findByRole("menuitem", { name: "Move" })).toBeTruthy();
			expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
			expect(screen.getByRole("menuitem", { name: "+ Child page" })).toBeTruthy();
		} finally {
			restore();
		}
	});

	it("keeps the desktop action row (no overflow menu) when not on a mobile viewport", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ Child page" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "More page actions" })).toBeNull();
	});

	it("toggles the page-tree drawer open/closed via the mobile 'Pages' trigger", async () => {
		const restore = mockMobileViewport();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })
			);
			render(<WikiPage />);
			await screen.findByText(/Select a page from the sidebar/i);

			const trigger = screen.getByRole("button", { name: "Pages" });
			expect(trigger.getAttribute("aria-expanded")).toBe("false");

			fireEvent.click(trigger);
			expect(trigger.getAttribute("aria-expanded")).toBe("true");

			fireEvent.click(trigger);
			expect(trigger.getAttribute("aria-expanded")).toBe("false");
		} finally {
			restore();
		}
	});

	it("closes the drawer when a page in the tree is navigated to", async () => {
		const restore = mockMobileViewport();
		try {
			const treeNode = { id: "w1", slug: "my-page", title: "My Page", type: null, children: [] };
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation((url: string) => {
					const u = String(url);
					if (u.includes("/tree")) {
						return Promise.resolve({ ok: true, json: () => Promise.resolve([treeNode]) });
					}
					if (u.includes("/revisions")) {
						return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
					}
					return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
				})
			);
			render(<WikiPage />);

			const trigger = await screen.findByRole("button", { name: "Pages" });
			fireEvent.click(trigger);
			expect(trigger.getAttribute("aria-expanded")).toBe("true");

			fireEvent.click(await screen.findByRole("button", { name: "My Page" }));
			await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
		} finally {
			restore();
		}
	});
});

describe("PROJ-796: Cancel with an unresolved restore banner keeps the draft", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("Edit → banner → Cancel writes no draft", async () => {
		const { draftPutCalls } = mockFetchWikiWithDraft({
			title: "From my laptop",
			content: "Unsaved work",
			baseRevisionId: null,
			updatedAt: 2_000_000,
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await vi.advanceTimersByTimeAsync(0);
		await screen.findByText(/Restore unsaved draft from/i);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await vi.advanceTimersByTimeAsync(2000);

		expect(draftPutCalls).toEqual([]);
	});
});

describe("PROJ-797: drafts and 409s are always recoverable", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("offers a draft even when the page was saved after it, and says so", async () => {
		mockFetchWikiWithDraft({
			title: "My Page",
			content: "my unsaved edit",
			baseRevisionId: "rev-old",
			// older than PAGE.updated_at (1000): someone else saved after my last autosave
			updatedAt: 500,
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(await screen.findByText(/Restore unsaved draft from/i)).toBeTruthy();
		expect(screen.getByText(/has been saved since this draft was started/i)).toBeTruthy();
	});

	it("after a 409, Overwrite with mine re-saves on top of the current revision", async () => {
		vi.useRealTimers();
		let puts = 0;
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.includes("/tree"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.includes("/draft"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
			if (init?.method === "PUT") {
				puts++;
				return puts === 1
					? Promise.resolve({ ok: false, status: 409 })
					: Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
			}
			// The first GET is what the editor opened with; later GETs see someone else's save.
			const revisionId = puts > 0 ? "rev-theirs" : "rev-mine";
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE, revisionId }) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		fireEvent.click(await screen.findByRole("button", { name: "Overwrite with mine" }));

		await waitFor(() => {
			const bodies = fetchMock.mock.calls
				.filter(([u, i]) => i?.method === "PUT" && !String(u).includes("/draft"))
				.map(([, i]) => JSON.parse(i.body).baseRevisionId);
			expect(bodies).toEqual(["rev-mine", "rev-theirs"]);
		});
	});
});

describe("PROJ-795: Back/Forward switch the displayed page", () => {
	it("popstate loads the page named by the URL", async () => {
		const pages: Record<string, WikiPageData> = {
			a: { ...PAGE, id: "wa", slug: "a", title: "Page A" },
			b: { ...PAGE, id: "wb", slug: "b", title: "Page B" },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				if (u.includes("/revisions") || u.includes("/tree"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				if (u.includes("/draft"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
				const slug = decodeURIComponent(u.split("/api/wiki/")[1] ?? "").split(/[/?]/)[0];
				return Promise.resolve({ ok: true, json: () => Promise.resolve(pages[slug] ?? pages.a) });
			})
		);
		window.history.replaceState(null, "", "/wiki/b");
		render(<WikiPage slug="b" />);
		await screen.findByText("Page B");

		window.history.replaceState(null, "", "/wiki/a");
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(await screen.findByText("Page A")).toBeTruthy();
	});
});

describe("out-of-order page/revision responses (PROJ-801)", () => {
	const realLocation = window.location;

	afterEach(() => {
		Object.defineProperty(window, "location", { configurable: true, value: realLocation });
	});

	function deferred<T>() {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	const jsonResponse = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

	it("keeps the last-navigated page and its revisions when the first page's responses arrive last", async () => {
		const PAGE_A: WikiPageData = { ...PAGE, id: "wa", slug: "page-a", title: "Page A" };
		const PAGE_B: WikiPageData = { ...PAGE, id: "wb", slug: "page-b", title: "Page B" };
		const REV_A = { id: "rev-a", author_id: "u1", author_name: "Ann", created_at: 1 };
		const REV_B = { id: "rev-b", author_id: "u1", author_name: "Ann", created_at: 2 };
		const slowPageA = deferred<ReturnType<typeof jsonResponse>>();
		const slowRevsA = deferred<ReturnType<typeof jsonResponse>>();

		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/auth/me")) {
				return Promise.resolve(
					jsonResponse({ user: { id: "u1", email: "a@example.com", name: "A" } })
				);
			}
			if (u.includes("/tree")) return Promise.resolve(jsonResponse([]));
			if (init?.method === "PUT") return Promise.resolve(jsonResponse(PAGE_B));
			if (u.includes("/api/wiki/page-a/revisions")) return slowRevsA.promise;
			if (u.includes("/api/wiki/page-b/revisions")) return Promise.resolve(jsonResponse([REV_B]));
			if (u.includes("/api/wiki/page-a")) return slowPageA.promise;
			if (u.includes("/api/wiki/page-b")) return Promise.resolve(jsonResponse(PAGE_B));
			return Promise.resolve({ ok: false, status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		// A plain location object so the canonical-slug redirect can be observed (see the
		// PROJ-487 block above for why jsdom's own Location can't be spied on).
		const replace = vi.fn();
		const loc = {
			pathname: "/wiki/page-a",
			search: "",
			origin: realLocation.origin,
			hostname: realLocation.hostname,
			host: realLocation.host,
			replace,
		};
		Object.defineProperty(window, "location", { configurable: true, value: loc });

		render(<WikiPage slug="page-a" />);
		// Navigate to B (Back/Forward path) before A has answered.
		loc.pathname = "/wiki/page-b";
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(await screen.findByText("Page B")).toBeTruthy();

		// A's responses finally arrive.
		slowPageA.resolve(jsonResponse(PAGE_A));
		slowRevsA.resolve(jsonResponse([REV_A]));
		await new Promise((r) => setTimeout(r, 20));

		expect(screen.getByText("Page B")).toBeTruthy();
		expect(screen.queryByText("Page A")).toBeNull();
		expect(replace).not.toHaveBeenCalled();

		// And B's save carries B's revision, not A's — no false 409.
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => {
			const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
			expect(putCall).toBeTruthy();
			expect(String(putCall?.[0])).toContain("/api/wiki/page-b");
			expect(JSON.parse(putCall?.[1].body)).toMatchObject({ baseRevisionId: "rev-b" });
		});
	});
});

describe("WikiPage — PROJ-860 memoised markdown rendering", () => {
	it("does not re-parse the article body when typing in the sidebar search", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const callsAfterMount = vi.mocked(markdownUtils.renderMdWithWikilinks).mock.calls.length;
		expect(callsAfterMount).toBeGreaterThan(0);

		const searchInput = screen.getByLabelText(/Search wiki pages/i);
		fireEvent.input(searchInput, { target: { value: "a" } });
		fireEvent.input(searchInput, { target: { value: "ab" } });
		fireEvent.input(searchInput, { target: { value: "abc" } });
		// Let the debounced search fire and its response land, so any re-render it
		// triggers has already happened by the time we assert.
		await new Promise((r) => setTimeout(r, 350));

		expect(vi.mocked(markdownUtils.renderMdWithWikilinks).mock.calls.length).toBe(callsAfterMount);
	});

	// The page usually lands before the tree (the tree is a bigger response), and the
	// wikilink title map comes from the tree — so the tree's arrival is the one legitimate
	// reason to re-render an unchanged page body. It must re-render exactly once, and the
	// post-render work (heading ids, mermaid) must follow the new HTML.
	it("re-renders exactly once when the tree arrives after the page, then reapplies ids and mermaid", async () => {
		const LINKED_PAGE: WikiPageData = {
			...PAGE,
			content: "## Setup\n\nSee [[Other Page]].\n\n```mermaid\ngraph TD\nA --> B\n```\n",
		};
		let resolveTree: (v: unknown) => void = () => {};
		const treeResponse = new Promise((r) => {
			resolveTree = r;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				if (u.includes("/tree")) return treeResponse;
				if (u.includes("/revisions"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				return Promise.resolve({ ok: true, json: () => Promise.resolve(LINKED_PAGE) });
			})
		);
		const renderMd = vi.mocked(markdownUtils.renderMdWithWikilinks);
		const mermaid = vi.mocked(markdownUtils.renderMermaidDiagrams);

		render(<WikiPage slug="my-page" />);
		await screen.findByRole("heading", { name: "My Page" });
		await waitFor(() => expect(document.getElementById("setup")).toBeTruthy());
		// No tree yet, so [[Other Page]] can't resolve and renders as a broken link.
		expect(document.querySelector(".wiki-link-broken")).toBeTruthy();
		await waitFor(() => expect(mermaid).toHaveBeenCalled());
		const parsesBeforeTree = renderMd.mock.calls.length;
		const mermaidBeforeTree = mermaid.mock.calls.length;

		resolveTree({
			ok: true,
			json: () =>
				Promise.resolve([
					{ id: "w1", slug: "my-page", title: "My Page", type: null, children: [] },
					{ id: "w2", slug: "other-page", title: "Other Page", type: null, children: [] },
				]),
		});

		const link = await waitFor(() => {
			const a = document.querySelector('.prose a[href="/wiki/other-page"]');
			expect(a).toBeTruthy();
			return a;
		});
		expect(link?.textContent).toBe("Other Page");
		// Replacing innerHTML dropped the old heading ids; the TOC effect must put them back
		// on the new nodes, and mermaid must hydrate the new placeholder.
		await waitFor(() => {
			expect(document.getElementById("setup")?.tagName).toBe("H2");
			expect(mermaid.mock.calls.length).toBeGreaterThan(mermaidBeforeTree);
		});
		expect(renderMd.mock.calls.length).toBe(parsesBeforeTree + 1);
	});
});

describe("WikiPage — PROJ-803 post-render effects survive remounts", () => {
	// Three headings so the TOC renders (it needs >= 3), a mermaid block, and a verify
	// signal so the Verify button is offered.
	const REMOUNT_PAGE: WikiPageData = {
		...PAGE,
		content:
			"# Title\n\n## Setup\n\nText.\n\n## Usage\n\nText.\n\n```mermaid\ngraph TD\nA --> B\n```\n",
		verify_interval: 30,
		verified_at: 1_000_000,
		freshness: { state: "stale", staleSince: 1_000_000 + 30 * 86400 },
	};
	const mermaid = vi.mocked(markdownUtils.renderMermaidDiagrams);

	beforeEach(() => {
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			}
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				const u = String(url);
				if (u.includes("/revisions"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				if (u.includes("/tree")) {
					const other = { id: "w2", slug: "other-page", title: "Other Page", children: [] };
					return Promise.resolve({ ok: true, json: () => Promise.resolve([other]) });
				}
				if (u.includes("/verify") && init?.method === "POST") {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ ok: true, verifiedAt: 2_000_000 }),
					});
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve(REMOUNT_PAGE) });
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// The bug: after a remount the TOC still held ids that only existed on the old,
	// detached heading nodes, so every TOC link pointed nowhere; and mermaid never ran
	// on the new node, leaving the raw code block.
	async function expectPostRenderWorkApplied(mermaidCallsBefore: number) {
		await waitFor(() => {
			expect(mermaid.mock.calls.length).toBeGreaterThan(mermaidCallsBefore);
			const content = document.querySelector(".prose");
			expect(content).toBeTruthy();
			// The latest mermaid call was handed the live content div, not a detached one.
			expect(mermaid.mock.calls.at(-1)?.[0]).toBe(content);
			const toc = screen.getByRole("navigation", { name: "Table of contents" });
			const hrefs = within(toc)
				.getAllByRole("link")
				.map((a) => a.getAttribute("href") ?? "");
			expect(hrefs).toEqual(["#title", "#setup", "#usage"]);
			for (const href of hrefs) {
				const target = document.getElementById(href.slice(1));
				expect(target && content?.contains(target)).toBe(true);
			}
		});
	}

	async function renderAndSettle() {
		render(<WikiPage slug="my-page" />);
		await screen.findByRole("heading", { name: "My Page" });
		await expectPostRenderWorkApplied(0);
		return mermaid.mock.calls.length;
	}

	// Verify/Move refetch asynchronously; until the refetch lands the old (correct) DOM is
	// still there, so assert only once the content div has actually been replaced —
	// otherwise the TOC checks would pass against the pre-action DOM.
	async function waitForContentRemount(oldNode: Element | null) {
		await waitFor(() => {
			const current = document.querySelector(".prose");
			expect(current).toBeTruthy();
			expect(current).not.toBe(oldNode);
		});
	}

	it("re-applies heading ids and mermaid after Cancel edit remounts the content div", async () => {
		const before = await renderAndSettle();

		// Editing swaps the rendered-content div for MarkdownEditor; Cancel brings back a
		// fresh node even though page.content never changed.
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await expectPostRenderWorkApplied(before);
	});

	it("re-applies heading ids and mermaid after Verify refetches the page", async () => {
		const before = await renderAndSettle();
		const oldNode = document.querySelector(".prose");

		fireEvent.click(screen.getByRole("button", { name: "Verify" }));

		await waitForContentRemount(oldNode);
		await expectPostRenderWorkApplied(before);
	});

	it("re-applies heading ids and mermaid after Move refetches the page", async () => {
		const before = await renderAndSettle();
		const oldNode = document.querySelector(".prose");

		fireEvent.click(screen.getByRole("button", { name: "Move" }));
		fireEvent.click(await screen.findByRole("combobox", { name: /new parent page/i }));
		fireEvent.click(await screen.findByRole("option", { name: "Other Page" }));
		const moveButtons = screen.getAllByRole("button", { name: "Move" });
		fireEvent.click(moveButtons[moveButtons.length - 1]);

		await waitForContentRemount(oldNode);
		await expectPostRenderWorkApplied(before);
	});
});

describe("WikiPage — PROJ-802 hash link scroll on load/nav/back-forward", () => {
	// Three headings so the ToC's IntersectionObserver effect also runs — jsdom has no
	// real IntersectionObserver, so it needs a stub.
	const HEADINGS_PAGE: WikiPageData = {
		...PAGE,
		content:
			"# Title\n\n## Setup\n\nSetup text.\n\n## Usage\n\nUsage text.\n\n## Notes\n\nMore text.",
	};

	let scrollIntoView: ReturnType<typeof vi.fn>;
	// biome-ignore lint/suspicious/noExplicitAny: jsdom doesn't implement scrollIntoView at all.
	const originalScrollIntoView = (Element.prototype as any).scrollIntoView;

	beforeEach(() => {
		scrollIntoView = vi.fn();
		// biome-ignore lint/suspicious/noExplicitAny: jsdom doesn't implement scrollIntoView at all.
		(Element.prototype as any).scrollIntoView = scrollIntoView;
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			}
		);
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: matches the cast above.
		(Element.prototype as any).scrollIntoView = originalScrollIntoView;
		vi.unstubAllGlobals();
	});

	it("scrolls to and focuses the heading matching location.hash once it renders", async () => {
		history.replaceState(null, "", "/wiki/my-page#setup");
		mockFetchWiki(HEADINGS_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		await waitFor(() => {
			expect(scrollIntoView).toHaveBeenCalled();
		});
		const heading = document.getElementById("setup");
		expect(heading).toBeTruthy();
		expect(heading?.getAttribute("tabindex")).toBe("-1");
		expect(document.activeElement).toBe(heading);
	});

	it("scrolls again on hashchange (in-app navigation) and on popstate (Back/Forward)", async () => {
		mockFetchWiki(HEADINGS_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => expect(document.getElementById("usage")).toBeTruthy());

		history.replaceState(null, "", "/wiki/my-page#usage");
		window.dispatchEvent(new Event("hashchange"));
		await waitFor(() => {
			expect(document.activeElement).toBe(document.getElementById("usage"));
		});

		history.replaceState(null, "", "/wiki/my-page#notes");
		window.dispatchEvent(new PopStateEvent("popstate"));
		await waitFor(() => {
			expect(document.activeElement).toBe(document.getElementById("notes"));
		});
	});

	it("does not re-scroll or steal focus when the TOC rebuilds on the same page and hash", async () => {
		history.replaceState(null, "", "/wiki/my-page#usage");
		mockFetchWiki(HEADINGS_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(document.activeElement).toBe(document.getElementById("usage"));
		});
		const scrollsAfterLoad = scrollIntoView.mock.calls.length;

		// Edit → Cancel remounts the content and rebuilds the TOC (PROJ-803) without any
		// navigation having happened. The user is working with the Edit/Cancel buttons;
		// yanking them back to #usage (and moving focus there) is the bug.
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		const editButton = screen.getByRole("button", { name: "Edit" });
		editButton.focus();
		// Wait until the rebuilt content has its ids again, i.e. the TOC rebuild happened.
		await waitFor(() => expect(document.getElementById("usage")?.tagName).toBe("H2"));
		await new Promise((r) => setTimeout(r, 50));

		expect(scrollIntoView.mock.calls.length).toBe(scrollsAfterLoad);
		expect(document.activeElement).toBe(editButton);

		// A real navigation back to the same hash still scrolls again.
		window.dispatchEvent(new Event("hashchange"));
		await waitFor(() => {
			expect(scrollIntoView.mock.calls.length).toBe(scrollsAfterLoad + 1);
			expect(document.activeElement).toBe(document.getElementById("usage"));
		});
	});

	it("only scrolls to targets inside the page content, not ids elsewhere on the page", async () => {
		// The sidebar drawer carries id="wiki-page-tree" — a hash naming it must not scroll
		// the sidebar into view or focus it.
		history.replaceState(null, "", "/wiki/my-page#wiki-page-tree");
		mockFetchWiki(HEADINGS_PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		await waitFor(() => expect(document.getElementById("usage")).toBeTruthy());
		expect(document.getElementById("wiki-page-tree")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 50));

		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(document.getElementById("wiki-page-tree"));
	});
});

describe("assignHeadingIds (PROJ-804)", () => {
	it("gives repeated heading text de-duplicated suffixes", () => {
		expect(
			assignHeadingIds([{ text: "Overview" }, { text: "Setup" }, { text: "Overview" }])
		).toEqual(["overview", "setup", "overview-1"]);
	});

	it("falls back to section-N (never an empty id) when text produces an empty slug", () => {
		expect(assignHeadingIds([{ text: "Setup" }, { text: "---" }, { text: "" }])).toEqual([
			"setup",
			"section-2",
			"section-3",
		]);
	});

	it("still de-dupes a section-N fallback against a heading literally titled that", () => {
		expect(assignHeadingIds([{ text: "Section 2" }, { text: "" }])).toEqual([
			"section-2",
			"section-2-1",
		]);
	});

	it("never hands out a suffixed id that a later heading's own text already produces", () => {
		const ids = assignHeadingIds([
			{ text: "Overview" },
			{ text: "Overview" },
			{ text: "Overview 1" },
		]);
		expect(ids).toEqual(["overview", "overview-1", "overview-1-1"]);
		expect(new Set(ids).size).toBe(ids.length);

		// Same collision with the order reversed: the suffix skips the taken id.
		expect(
			assignHeadingIds([{ text: "Overview 1" }, { text: "Overview" }, { text: "Overview" }])
		).toEqual(["overview-1", "overview", "overview-2"]);
	});

	it("keeps authored ids and steers generated ones around them", () => {
		expect(
			assignHeadingIds([
				{ text: "Setup" }, // would be `setup`, but an author claimed that below
				{ text: "Install", id: "setup" },
				{ text: "Custom anchor", id: "my-anchor" },
				{ text: "My anchor" }, // slugs to `my-anchor`, which is taken
			])
		).toEqual(["setup-1", "setup", "my-anchor", "my-anchor-1"]);
	});

	it("re-suffixes only a repeated authored id, and is a no-op on ids it already assigned", () => {
		expect(
			assignHeadingIds([
				{ text: "A", id: "dup" },
				{ text: "B", id: "dup" },
			])
		).toEqual(["dup", "dup-1"]);

		const first = assignHeadingIds([{ text: "Overview" }, { text: "Overview" }, { text: "" }]);
		const again = assignHeadingIds(
			[{ text: "Overview" }, { text: "Overview" }, { text: "" }].map((h, i) => ({
				...h,
				id: first[i],
			}))
		);
		expect(again).toEqual(first);
	});
});

describe("WikiPage — PROJ-804 duplicate/empty heading ids in the rendered TOC", () => {
	beforeEach(() => {
		// Three headings mean the ToC's IntersectionObserver effect also runs — jsdom has
		// no real IntersectionObserver, so it needs a stub (see PROJ-802's describe block).
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			}
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders unique anchors and TOC entries for duplicate and blank headings", async () => {
		mockFetchWiki({
			...PAGE,
			content: "# Overview\n\nIntro.\n\n## Setup\n\nSetup text.\n\n## Overview\n\nMore text.",
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		await waitFor(() => {
			expect(document.querySelectorAll('[id="overview"]')).toHaveLength(1);
			expect(document.querySelectorAll('[id="overview-1"]')).toHaveLength(1);
		});
		const toc = within(screen.getByRole("navigation", { name: "Table of contents" }));
		expect(toc.getByRole("link", { name: "Setup" }).getAttribute("href")).toBe("#setup");
		const overviewLinks = toc.getAllByRole("link", { name: "Overview" });
		expect(overviewLinks.map((a) => a.getAttribute("href")).sort()).toEqual([
			"#overview",
			"#overview-1",
		]);
	});

	it("keeps an authored heading id from the markdown instead of overwriting it", async () => {
		mockFetchWiki({
			...PAGE,
			content:
				'# Guide\n\n<h2 id="install-guide">Install</h2>\n\nText.\n\n## Overview\n\nText.\n\n## Overview 1\n\nText.\n\n## Overview\n\nText.',
		});
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		await waitFor(() => {
			expect(document.getElementById("install-guide")?.textContent).toBe("Install");
		});
		const toc = within(screen.getByRole("navigation", { name: "Table of contents" }));
		expect(toc.getByRole("link", { name: "Install" }).getAttribute("href")).toBe("#install-guide");
		const hrefs = toc.getAllByRole("link").map((a) => a.getAttribute("href"));
		expect(hrefs).toEqual(["#guide", "#install-guide", "#overview", "#overview-1", "#overview-2"]);
		// Every heading id in the article is unique.
		const headingIds = Array.from(document.querySelectorAll(".prose :is(h1, h2, h3)")).map(
			(h) => h.id
		);
		expect(new Set(headingIds).size).toBe(headingIds.length);
	});
});

describe("WikiPage — PROJ-805 stale sidebar search responses", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function searchResult(id: string, title: string) {
		return {
			id,
			slug: id,
			title,
			project_id: null,
			excerpt: null,
			type: null,
			status: null,
			tags: [] as string[],
			freshness: null,
		};
	}

	it("discards a slower response for an earlier query once a newer query's response has landed", async () => {
		let resolveFirst: (v: unknown) => void = () => {};
		const firstResponse = new Promise((r) => {
			resolveFirst = r;
		});

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = new URL(String(url), "http://localhost");
			if (u.pathname.includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ user: { id: "u1", email: "a@example.com", name: "A" } }),
				});
			}
			if (u.pathname.includes("/revisions"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.pathname.includes("/tree"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.pathname === "/api/wiki/search") {
				const q = u.searchParams.get("q");
				if (q === "ab") return firstResponse; // slow — resolves later, below
				if (q === "abc") {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([searchResult("r2", "Second Result")]),
					});
				}
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const searchInput = screen.getByLabelText(/Search wiki pages/i);
		fireEvent.input(searchInput, { target: { value: "ab" } });
		await vi.advanceTimersByTimeAsync(300); // "ab"'s debounce fires; its fetch is left in flight.

		fireEvent.input(searchInput, { target: { value: "abc" } });
		await vi.advanceTimersByTimeAsync(300); // "abc"'s debounce fires and its fetch resolves.

		expect(await screen.findByText("Second Result")).toBeTruthy();

		// The slow "ab" response finally arrives after "abc"'s has already landed — it
		// must not overwrite the newer, already-displayed results.
		resolveFirst({
			ok: true,
			json: () => Promise.resolve([searchResult("r1", "First Result")]),
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(screen.queryByText("First Result")).toBeNull();
		expect(screen.getByText("Second Result")).toBeTruthy();
	});

	function listItem(id: string, title: string) {
		return { id, slug: id, title, type: null, status: null, tags: [] as string[] };
	}

	it("discards a slower filter response for an earlier tag filter once a newer one has landed", async () => {
		let resolveFirst: (v: unknown) => void = () => {};
		const firstResponse = new Promise((r) => {
			resolveFirst = r;
		});

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const u = new URL(String(url), "http://localhost");
			if (u.pathname.includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ user: { id: "u1", email: "a@example.com", name: "A" } }),
				});
			}
			if (u.pathname.includes("/revisions"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.pathname.includes("/tree"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.pathname === "/api/wiki" && u.searchParams.has("tags")) {
				const tags = u.searchParams.get("tags");
				if (tags === "ab") return firstResponse; // slow — resolves later, below
				if (tags === "abc") {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([listItem("f2", "Second Filtered")]),
					});
				}
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const tagsInput = screen.getByLabelText(/Filter wiki pages by tags/i);
		fireEvent.input(tagsInput, { target: { value: "ab" } });
		await vi.advanceTimersByTimeAsync(300);

		fireEvent.input(tagsInput, { target: { value: "abc" } });
		await vi.advanceTimersByTimeAsync(300);

		expect(await screen.findByText("Second Filtered")).toBeTruthy();

		resolveFirst({
			ok: true,
			json: () => Promise.resolve([listItem("f1", "First Filtered")]),
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(screen.queryByText("First Filtered")).toBeNull();
		expect(screen.getByText("Second Filtered")).toBeTruthy();
	});

	// The first two tests only cover a stale response landing *after* the newer one. It
	// can also land while the newer input's debounce is still pending — before any newer
	// request exists to out-rank it — and used to be applied then (clearing the loading
	// state and showing results for input the user has already changed).
	function mockFetchWithSlowFirst(
		match: (u: URL) => string | null,
		slowKey: string,
		fastKey: string,
		fastBody: unknown
	) {
		let resolveSlow: (v: unknown) => void = () => {};
		const slow = new Promise((r) => {
			resolveSlow = r;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = new URL(String(url), "http://localhost");
				if (u.pathname.includes("/revisions") || u.pathname.includes("/tree"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				const key = match(u);
				if (key === slowKey) return slow;
				if (key === fastKey)
					return Promise.resolve({ ok: true, json: () => Promise.resolve(fastBody) });
				return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
			})
		);
		return (body: unknown) => resolveSlow({ ok: true, json: () => Promise.resolve(body) });
	}

	it("drops an in-flight search response once the query changes, even before the new debounce fires", async () => {
		const resolveSlow = mockFetchWithSlowFirst(
			(u) => (u.pathname === "/api/wiki/search" ? u.searchParams.get("q") : null),
			"ab",
			"abc",
			[searchResult("r2", "Second Result")]
		);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const searchInput = screen.getByLabelText(/Search wiki pages/i);
		fireEvent.input(searchInput, { target: { value: "ab" } });
		await vi.advanceTimersByTimeAsync(300); // "ab" is now in flight.
		fireEvent.input(searchInput, { target: { value: "abc" } }); // debounce pending.

		resolveSlow([searchResult("r1", "First Result")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByText("First Result")).toBeNull();
		expect(screen.getByText("Searching…")).toBeTruthy();

		await vi.advanceTimersByTimeAsync(300);
		expect(await screen.findByText("Second Result")).toBeTruthy();
		expect(screen.queryByText("First Result")).toBeNull();
	});

	it("drops an in-flight filter response once the filter changes, even before the new debounce fires", async () => {
		const resolveSlow = mockFetchWithSlowFirst(
			(u) => (u.pathname === "/api/wiki" ? u.searchParams.get("tags") : null),
			"ab",
			"abc",
			[listItem("f2", "Second Filtered")]
		);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const tagsInput = screen.getByLabelText(/Filter wiki pages by tags/i);
		fireEvent.input(tagsInput, { target: { value: "ab" } });
		await vi.advanceTimersByTimeAsync(300);
		fireEvent.input(tagsInput, { target: { value: "abc" } });

		resolveSlow([listItem("f1", "First Filtered")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByText("First Filtered")).toBeNull();

		await vi.advanceTimersByTimeAsync(300);
		expect(await screen.findByText("Second Filtered")).toBeTruthy();
		expect(screen.queryByText("First Filtered")).toBeNull();
	});
});

describe("WikiPage — PROJ-806 a11y: closed drawer, menu, tree, breadcrumb", () => {
	it("keeps the closed mobile drawer inert and does not move focus to it on initial mount", async () => {
		const restore = mockMobileViewport();
		try {
			mockFetchWiki(PAGE);
			render(<WikiPage slug="my-page" />);
			await screen.findByText("My Page");

			const drawer = document.getElementById("wiki-page-tree");
			expect(drawer).toBeTruthy();
			expect(drawer?.hasAttribute("inert")).toBe(true);
			// The "Pages" trigger must not have received focus just because the page loaded.
			expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Pages" }));
		} finally {
			restore();
		}
	});

	it("is not inert once opened, and is inert again after closing", async () => {
		const restore = mockMobileViewport();
		try {
			mockFetchWiki(PAGE);
			render(<WikiPage slug="my-page" />);
			await screen.findByText("My Page");

			const trigger = screen.getByRole("button", { name: "Pages" });
			const drawer = document.getElementById("wiki-page-tree");

			fireEvent.click(trigger);
			expect(drawer?.hasAttribute("inert")).toBe(false);

			fireEvent.click(trigger);
			expect(drawer?.hasAttribute("inert")).toBe(true);
		} finally {
			restore();
		}
	});

	it("marks the current page's tree item with aria-current=page", async () => {
		const treeNode = {
			id: "w1",
			slug: "my-page",
			title: "My Page",
			type: null,
			children: [{ id: "w2", slug: "other-page", title: "Other Page", type: null, children: [] }],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				if (u.includes("/tree"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([treeNode]) });
				if (u.includes("/revisions"))
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
			})
		);
		render(<WikiPage slug="my-page" />);
		// The tree also has a "My Page" node, so this waits on the heading specifically
		// rather than plain text (which would match both and fail as ambiguous).
		await screen.findByRole("heading", { name: "My Page" });

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "My Page" }).getAttribute("aria-current")).toBe(
				"page"
			);
		});
		expect(
			screen.getByRole("button", { name: /Other Page/ }).getAttribute("aria-current")
		).toBeNull();
	});

	it("moves focus into the ⋯ menu on open and supports ArrowDown/ArrowUp navigation", async () => {
		const restore = mockMobileViewport();
		try {
			mockFetchWiki(PAGE);
			render(<WikiPage slug="my-page" />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "More page actions" }));
			const childItem = await screen.findByRole("menuitem", { name: "+ Child page" });
			const moveItem = screen.getByRole("menuitem", { name: "Move" });
			const deleteItem = screen.getByRole("menuitem", { name: "Delete" });

			expect(document.activeElement).toBe(childItem);

			fireEvent.keyDown(childItem, { key: "ArrowDown" });
			expect(document.activeElement).toBe(moveItem);

			fireEvent.keyDown(moveItem, { key: "ArrowDown" });
			expect(document.activeElement).toBe(deleteItem);

			// Wraps back to the first item.
			fireEvent.keyDown(deleteItem, { key: "ArrowDown" });
			expect(document.activeElement).toBe(childItem);

			fireEvent.keyDown(childItem, { key: "ArrowUp" });
			expect(document.activeElement).toBe(deleteItem);
		} finally {
			restore();
		}
	});

	it("keeps menu items out of the Tab order and closes the menu back to its trigger on Tab, Escape, or an action", async () => {
		const restore = mockMobileViewport();
		try {
			mockFetchWiki(PAGE);
			render(<WikiPage slug="my-page" />);
			await screen.findByText("My Page");
			const trigger = screen.getByRole("button", { name: "More page actions" });

			fireEvent.click(trigger);
			const items = await screen.findAllByRole("menuitem");
			expect(items.map((i) => i.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);

			// Tab closes the menu and lands back on ⋯ (not wherever the portal sits).
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
			expect(screen.queryByRole("menu")).toBeNull();
			expect(document.activeElement).toBe(trigger);

			fireEvent.click(trigger);
			await screen.findByRole("menu");
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
			expect(screen.queryByRole("menu")).toBeNull();
			expect(document.activeElement).toBe(trigger);

			// Choosing an action unmounts the focused item; focus returns to ⋯ rather than
			// falling to <body>.
			fireEvent.click(trigger);
			fireEvent.click(await screen.findByRole("menuitem", { name: "Move" }));
			expect(screen.queryByRole("menu")).toBeNull();
			expect(await screen.findByRole("combobox", { name: /new parent page/i })).toBeTruthy();
			expect(document.activeElement).toBe(trigger);
		} finally {
			restore();
		}
	});

	it("delays the closed drawer's visibility:hidden until its slide-out transition finishes", async () => {
		mockFetchWiki(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		const css = Array.from(document.querySelectorAll("style"))
			.map((el) => el.textContent ?? "")
			.find((text) => text.includes(".wiki-sidebar.wiki-sidebar-open"));
		expect(css).toBeTruthy();
		const rule = (selector: string) =>
			css?.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
		const closed = rule(".wiki-sidebar");
		const opened = rule(".wiki-sidebar.wiki-sidebar-open");
		expect(closed).toMatch(/visibility:\s*hidden/);
		expect(closed).toMatch(/transition:[^;]*visibility 0s linear 0\.22s/);
		expect(opened).toMatch(/transition:[^;]*visibility 0s linear 0s/);
	});
});

// PROJ-807: the delete confirmation used to say "This cannot be undone" even though the
// backend soft-deletes into a 30-day trash with an undelete endpoint. The dialog copy
// should say so, and a successful delete should offer an in-page Undo rather than
// forcing the user straight to the trash view to recover.
describe("WikiPage — PROJ-807 delete confirmation wording + undo toast", () => {
	const UNDELETED = { ok: true, id: "w1", slug: "my-page", url: "/wiki/my-page", restoredCount: 2 };

	function mockFetchWikiWithDelete(
		opts: Readonly<{
			undelete?: Promise<unknown>;
			treeFailsAfterUndelete?: boolean;
		}> = {}
	) {
		let undeleted = false;
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({ user: { id: "u1", email: "real-user@example.com", name: "User" } }),
				});
			}
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				if (undeleted && opts.treeFailsAfterUndelete) {
					return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/undelete")) {
				undeleted = true;
				return (
					opts.undelete ?? Promise.resolve({ ok: true, json: () => Promise.resolve(UNDELETED) })
				);
			}
			if (init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 204 });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	const callsTo = (fetchMock: ReturnType<typeof vi.fn>, method: string, match: RegExp) =>
		fetchMock.mock.calls
			.filter(([u, init]) => (init as RequestInit)?.method === method && match.test(String(u)))
			.map(([u]) => String(u));

	// Earlier tests in this file spy on window.confirm without restoring it (see the
	// PROJ-796 restore-banner tests above) — vi.spyOn on an already-spied method reuses the
	// same mock and its call history, so clear it before asserting call counts.
	function mockConfirm(answer: boolean) {
		const spy = vi.spyOn(window, "confirm").mockReturnValue(answer);
		spy.mockClear();
		return spy;
	}

	async function deleteMyPage() {
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		return screen.findByRole("status");
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("tells the user the page moves to trash for 30 days, not that deletion is permanent", async () => {
		const fetchMock = mockFetchWikiWithDelete();
		const confirmSpy = mockConfirm(false);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		expect(confirmSpy).toHaveBeenCalledTimes(1);
		const message = confirmSpy.mock.calls[0][0];
		expect(message).toMatch(/trash/i);
		expect(message).toMatch(/30 days/);
		expect(message).not.toMatch(/cannot be undone/i);
		// User declined the confirm() above — no DELETE should have been issued.
		expect(callsTo(fetchMock, "DELETE", /./)).toEqual([]);
	});

	it("deletes with cascade=true, so the children really go to the trash with the page", async () => {
		const fetchMock = mockFetchWikiWithDelete();
		mockConfirm(true);
		await deleteMyPage();

		// Without cascade the API re-parents the children instead of trashing them — the
		// dialog's "and any children" would be false and Undo couldn't restore the tree.
		expect(callsTo(fetchMock, "DELETE", /^\/api\/wiki\//)).toEqual([
			"/api/wiki/my-page?cascade=true",
		]);
	});

	it("Undo POSTs the deleted page's id to the undelete endpoint and returns to the page", async () => {
		const fetchMock = mockFetchWikiWithDelete();
		mockConfirm(true);
		const toast = await deleteMyPage();
		expect(within(toast).getByText(/moved to trash/i)).toBeTruthy();
		expect(window.location.pathname).toBe("/wiki");

		fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));

		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		// By id, not slug: a trashed page's slug may already belong to a live page.
		expect(callsTo(fetchMock, "POST", /undelete/)).toEqual(["/api/wiki/trash/w1/undelete"]);
		expect(window.location.pathname).toBe("/wiki/my-page");
		expect(await screen.findByRole("heading", { name: "My Page" })).toBeTruthy();
	});

	it("keeps the toast and reports the failure when the undelete itself fails", async () => {
		mockFetchWikiWithDelete({
			undelete: Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
		});
		mockConfirm(true);
		const toast = await deleteMyPage();

		fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));

		expect(await within(toast).findByText(/Undo failed/)).toBeTruthy();
		expect(screen.getByRole("status")).toBe(toast);
		expect(window.location.pathname).toBe("/wiki");
	});

	it("does not report 'Undo failed' when the undelete succeeded but the tree refresh after it fails", async () => {
		mockFetchWikiWithDelete({ treeFailsAfterUndelete: true });
		mockConfirm(true);
		const toast = await deleteMyPage();

		fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));

		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(screen.queryByText(/Undo failed/)).toBeNull();
		expect(window.location.pathname).toBe("/wiki/my-page");
	});

	it("auto-dismisses after 8s, but not while hovered, focused, or while Undo is running", async () => {
		vi.useFakeTimers();
		let resolveUndelete: (v: unknown) => void = () => {};
		mockFetchWikiWithDelete({
			undelete: new Promise((r) => {
				resolveUndelete = r;
			}),
		});
		mockConfirm(true);
		render(<WikiPage slug="my-page" />);
		await vi.advanceTimersByTimeAsync(0);
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		// Let the toast mount and its (after-paint) timer effect run.
		await vi.advanceTimersByTimeAsync(200);
		const toast = screen.getByRole("status");

		// Hovered: the countdown is suspended however long they read it…
		fireEvent.mouseEnter(toast);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(screen.queryByRole("status")).toBe(toast);
		// …and restarts in full on leave.
		fireEvent.mouseLeave(toast);
		await vi.advanceTimersByTimeAsync(7_000);
		expect(screen.queryByRole("status")).toBe(toast);

		// Keyboard focus inside the toast pauses it too.
		// (Real focus(): jsdom then fires genuine bubbling focusin/focusout.)
		const undoButton = within(toast).getByRole("button", { name: "Undo" });
		undoButton.focus();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(screen.queryByRole("status")).toBe(toast);

		// An Undo in flight keeps it up even once focus and pointer have left. (Focus
		// moves to a real control outside the toast — the Undo button is disabled while
		// running, and blur() on it is a no-op in jsdom.)
		fireEvent.click(undoButton);
		screen.getByLabelText(/Search wiki pages/i).focus();
		expect(toast.contains(document.activeElement)).toBe(false);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(screen.queryByRole("status")).toBe(toast);
		expect(within(toast).getByText("Undoing…")).toBeTruthy();

		resolveUndelete({ ok: true, json: () => Promise.resolve(UNDELETED) });
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("dismisses itself after 8s when left alone", async () => {
		vi.useFakeTimers();
		mockFetchWikiWithDelete();
		mockConfirm(true);
		render(<WikiPage slug="my-page" />);
		await vi.advanceTimersByTimeAsync(0);
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		// Let the toast mount and its (after-paint) timer effect run.
		await vi.advanceTimersByTimeAsync(200);
		expect(screen.getByRole("status")).toBeTruthy();

		await vi.advanceTimersByTimeAsync(7_500);
		expect(screen.queryByRole("status")).toBeTruthy();
		await vi.advanceTimersByTimeAsync(500);
		expect(screen.queryByRole("status")).toBeNull();
	});
});
