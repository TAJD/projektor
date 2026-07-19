// WikiPage island — mock-fetch tests.
//
// WikiPage reads ?slug= from the URL, fetches the tree + page + revisions via
// apiFetch (which calls global fetch). The pattern: set the URL with
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

function mockFetchWiki(page: WikiPageData | null, ok = true) {
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
				return Promise.resolve({ ok: false, status: 404 });
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
		history.replaceState(null, "", "?slug=my-page");
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<WikiPage />);
		// Both the sidebar tree and the main content show "Loading…" while pending.
		// findAllByText waits for at least one match.
		const loadingEls = await screen.findAllByText("Loading…");
		expect(loadingEls.length).toBeGreaterThan(0);
	});

	it("renders page title and content after fetch resolves", async () => {
		history.replaceState(null, "", "?slug=my-page");
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		expect(await screen.findByText("My Page")).toBeTruthy();
	});

	it("shows Edit button once the page is loaded", async () => {
		history.replaceState(null, "", "?slug=my-page");
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		await screen.findByText("My Page");
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
	});

	it("shows an error message when the page fetch fails", async () => {
		history.replaceState(null, "", "?slug=my-page");
		mockFetchWiki(null, false);
		render(<WikiPage />);
		expect(await screen.findByText(/Failed to load page/i)).toBeTruthy();
	});

	it("shows Move button once the page is loaded", async () => {
		history.replaceState(null, "", "?slug=my-page");
		mockFetchWiki(PAGE);
		render(<WikiPage />);
		await screen.findByText("My Page");
		expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
	});

	it("moves a page to a new parent via PUT and refetches tree/page", async () => {
		history.replaceState(null, "", "?slug=my-page");
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
		render(<WikiPage />);
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
		history.replaceState(null, "", "?slug=my-page");
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage />);
		await screen.findByText("My Page");
		expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
			/Workspace \(all projects\)/i
		);
	});

	it("shows the project's scope when projectId is set via the URL", async () => {
		history.replaceState(null, "", "?slug=my-page&projectId=p1");
		mockFetchWikiWithProjects(PAGE);
		render(<WikiPage />);
		await screen.findByText("My Page");
		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Wiki project scope" }).textContent).toMatch(
				/PROJ — Projektor/i
			);
		});
	});
});

async function startEditingWithTitleInput(): Promise<HTMLInputElement> {
	history.replaceState(null, "", "?slug=my-page");
	mockFetchWiki(PAGE);
	render(<WikiPage />);
	await screen.findByText("My Page");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	return screen.getByLabelText("Page title") as HTMLInputElement;
}

async function renderWithDraftAndOpenEdit(draft: {
	title: string;
	content: string;
	savedAt: number;
}) {
	history.replaceState(null, "", "?slug=my-page");
	localStorage.setItem("wiki-draft:w1", JSON.stringify(draft));
	mockFetchWiki(PAGE);
	render(<WikiPage />);
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
