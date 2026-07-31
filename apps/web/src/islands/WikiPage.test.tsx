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

interface WikiPageData {
	id: string;
	slug: string;
	title: string;
	content: string;
	parent_id: string | null;
	updated_at: number;
}

const PAGE: WikiPageData = {
	id: "w1",
	slug: "my-page",
	title: "My Page",
	content: "Hello world content.",
	parent_id: null,
	updated_at: 1000,
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
