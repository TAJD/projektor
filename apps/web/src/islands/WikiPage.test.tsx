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
import WikiPage from "./WikiPage";

interface WikiFreshness {
	state: "fresh" | "stale" | "unverified";
	staleSince: number | null;
}

interface WikiPageData {
	id: string;
	slug: string;
	title: string;
	content: string;
	parent_id: string | null;
	updated_at: number;
	type: string | null;
	tags: string[];
	status: string | null;
	verified_at: number | null;
	verified_by: string | null;
	owners: string[];
	verify_interval: number | null;
	freshness: WikiFreshness | null;
}

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
		const OTHER_PAGE_NODE = { id: "w2", slug: "other-page", title: "Other Page", children: [] };
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([OTHER_PAGE_NODE]) });
			}
			if (init?.method === "PUT") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Move" }));
		fireEvent.click(await screen.findByRole("combobox", { name: /new parent page/i }));
		fireEvent.click(await screen.findByRole("option", { name: "Other Page" }));
		const moveButtons = screen.getAllByRole("button", { name: "Move" });
		fireEvent.click(moveButtons[moveButtons.length - 1]);

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

	it("redirects straight to the current canonical slug, not the requested one (avoids a redirect chain, PROJ-483)", async () => {
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

async function startEditingWithTitleInput(): Promise<HTMLInputElement> {
	mockFetchWiki(PAGE);
	render(<WikiPage slug="my-page" />);
	await screen.findByText("My Page");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	return screen.getByLabelText("Page title") as HTMLInputElement;
}

async function renderWithDraftAndOpenEdit(draft: {
	title: string;
	content: string;
	savedAt: number;
}) {
	localStorage.setItem("wiki-draft:w1", JSON.stringify(draft));
	mockFetchWiki(PAGE);
	render(<WikiPage slug="my-page" />);
	await screen.findByText("My Page");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
}

describe("draft autosave (PROJ-227)", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it("writes a draft to localStorage after debounce while editing", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });

		expect(localStorage.getItem("wiki-draft:w1")).toBeNull();

		await vi.advanceTimersByTimeAsync(1000);

		const raw = localStorage.getItem("wiki-draft:w1");
		expect(raw).toBeTruthy();
		const draft = JSON.parse(raw as string);
		expect(draft.title).toBe("My Page Edited");
		expect(draft.content).toBe(PAGE.content);
	});

	it("clears the draft from localStorage after a successful save", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(1000);
		expect(localStorage.getItem("wiki-draft:w1")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await vi.advanceTimersByTimeAsync(0);
		await waitFor(() => {
			expect(localStorage.getItem("wiki-draft:w1")).toBeNull();
		});
	});

	it("keeps the draft in localStorage when editing is cancelled", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
		await vi.advanceTimersByTimeAsync(1000);
		expect(localStorage.getItem("wiki-draft:w1")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const raw = localStorage.getItem("wiki-draft:w1");
		expect(raw).toBeTruthy();
		expect(JSON.parse(raw as string).title).toBe("My Page Edited");
	});

	it("flushes unflushed edits to the draft when leaving edit mode via navigation", async () => {
		const titleInput = await startEditingWithTitleInput();
		fireEvent.input(titleInput, { target: { value: "Typed just before navigating away" } });

		// Navigate away (e.g. clicking a sidebar link) before the 1s debounce fires.
		expect(localStorage.getItem("wiki-draft:w1")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "+ New page" }));

		const raw = localStorage.getItem("wiki-draft:w1");
		expect(raw).toBeTruthy();
		expect(JSON.parse(raw as string).title).toBe("Typed just before navigating away");
	});
});

describe("draft autosave (PROJ-227) — restore banner", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it("shows a restore banner when a newer draft exists on startEdit", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			savedAt: 2_000_000,
		});
		expect(await screen.findByText(/Restore unsaved draft from/i)).toBeTruthy();
	});

	it("restore populates the fields from the draft and dismisses the banner", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			savedAt: 2_000_000,
		});
		await screen.findByText(/Restore unsaved draft from/i);
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));

		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		expect(titleInput.value).toBe("Draft Title");
		expect(screen.queryByText(/Restore unsaved draft from/i)).toBeNull();
	});

	it("discard removes the draft and falls through to loading from the page", async () => {
		await renderWithDraftAndOpenEdit({
			title: "Draft Title",
			content: "Draft content",
			savedAt: 2_000_000,
		});
		await screen.findByText(/Restore unsaved draft from/i);
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));

		const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
		expect(titleInput.value).toBe(PAGE.title);
		expect(localStorage.getItem("wiki-draft:w1")).toBeNull();
	});
});

// PROJ-507: PROJ-484 added optimistic locking to PUT /api/wiki/:slug (an optional
// baseRevisionId that must match the page's current latest revision, else a 409), but
// the save path here never sent it — silently defeating the whole feature. These
// tests cover that the loaded revision id is now sent, and that a 409 is surfaced
// rather than swallowed.
describe("optimistic locking (PROJ-507)", () => {
	const REVISION = { id: "rev-1", author_id: "u1", author_name: "Ann", created_at: 500 };

	function mockFetchWikiWithRevision(putResponse: { ok: boolean; status?: number }) {
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
		const OTHER_PAGE_NODE = { id: "w2", slug: "other-page", title: "Other Page", children: [] };
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/revisions")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([REVISION]) });
			}
			if (u.includes("/tree")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([OTHER_PAGE_NODE]) });
			}
			if (init?.method === "PUT") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...PAGE }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PAGE) });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<WikiPage slug="my-page" />);
		await screen.findByText("My Page");

		fireEvent.click(screen.getByRole("button", { name: "Move" }));
		fireEvent.click(await screen.findByRole("combobox", { name: /new parent page/i }));
		fireEvent.click(await screen.findByRole("option", { name: "Other Page" }));
		const moveButtons = screen.getAllByRole("button", { name: "Move" });
		fireEvent.click(moveButtons[moveButtons.length - 1]);
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

	function mockFetchWithRevision(opts: {
		diff?: { from: string; to: string; diff: string };
		oldRevisionContent?: string;
		putResponse?: { ok: boolean; status?: number };
	}) {
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
