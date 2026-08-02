// WikiPage island — mock-fetch tests.
//
// WikiPage resolves its slug from (in order) the `slug` prop — how the /wiki/:slug
// astro routes render it (PROJ-487) — a `?slug=` query param (legacy), or the
// pathname (production's wiki/view.astro shell). It fetches the tree + page +
// revisions via apiFetch (which calls global fetch). The pattern: set the URL with
// history.replaceState, override the default stub from setup.ts with
// vi.stubGlobal, then await findBy* for the async state update.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WikiPage, { type ServerDraft, type WikiPageData } from "./WikiPage";

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

function mockFetchWiki(page: WikiPageData | null, ok = true, status = 404) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
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

function mockFetchMovePage(revisions: unknown[] = []) {
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

describe("WikiPage — project scope control (PROJ-352)", () => {
	function mockFetchWikiWithProjects(page: WikiPageData | null) {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
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

	it("defaults to 'Workspace (all projects)' scope when no projectId is set", async () => {
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");
		expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
			/Workspace \(all projects\)/i
		);
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
		const body = JSON.parse((putCall?.[1] as RequestInit).body as string);
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
		const body = JSON.parse((putCall?.[1] as RequestInit).body as string);
		expect(body.title).toBe("Typed just before navigating away");
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

	it("does not offer a draft older than the page's current published content", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Stale Draft Title",
			content: "Stale draft content",
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

		expect(await screen.findByText(/changed by someone else since you loaded it/i)).toBeTruthy();
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
