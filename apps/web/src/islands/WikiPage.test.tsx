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
			history.replaceState(null, "", "?slug=my-page");
			mockFetchWiki(PAGE);
			render(<WikiPage />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: "My Page Edited" } });

			expect(localStorage.getItem("wiki-draft:w1")).toBeNull();

			await vi.advanceTimersByTimeAsync(1000);

			const raw = localStorage.getItem("wiki-draft:w1");
			expect(raw).toBeTruthy();
			const draft = JSON.parse(raw as string);
			expect(draft.title).toBe("My Page Edited");
			expect(draft.content).toBe(PAGE.content);
		});

		it("shows a restore banner when a newer draft exists on startEdit", async () => {
			history.replaceState(null, "", "?slug=my-page");
			localStorage.setItem(
				"wiki-draft:w1",
				JSON.stringify({ title: "Draft Title", content: "Draft content", savedAt: 2_000_000 })
			);
			mockFetchWiki(PAGE);
			render(<WikiPage />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			expect(await screen.findByText(/Restore unsaved draft from/i)).toBeTruthy();
		});

		it("restore populates the fields from the draft and dismisses the banner", async () => {
			history.replaceState(null, "", "?slug=my-page");
			localStorage.setItem(
				"wiki-draft:w1",
				JSON.stringify({ title: "Draft Title", content: "Draft content", savedAt: 2_000_000 })
			);
			mockFetchWiki(PAGE);
			render(<WikiPage />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			await screen.findByText(/Restore unsaved draft from/i);
			fireEvent.click(screen.getByRole("button", { name: "Restore" }));

			const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
			expect(titleInput.value).toBe("Draft Title");
			expect(screen.queryByText(/Restore unsaved draft from/i)).toBeNull();
		});

		it("discard removes the draft and falls through to loading from the page", async () => {
			history.replaceState(null, "", "?slug=my-page");
			localStorage.setItem(
				"wiki-draft:w1",
				JSON.stringify({ title: "Draft Title", content: "Draft content", savedAt: 2_000_000 })
			);
			mockFetchWiki(PAGE);
			render(<WikiPage />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			await screen.findByText(/Restore unsaved draft from/i);
			fireEvent.click(screen.getByRole("button", { name: "Discard" }));

			const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
			expect(titleInput.value).toBe(PAGE.title);
			expect(localStorage.getItem("wiki-draft:w1")).toBeNull();
		});

		it("clears the draft from localStorage after a successful save", async () => {
			history.replaceState(null, "", "?slug=my-page");
			mockFetchWiki(PAGE);
			render(<WikiPage />);
			await screen.findByText("My Page");

			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			const titleInput = screen.getByLabelText("Page title") as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: "My Page Edited" } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(localStorage.getItem("wiki-draft:w1")).toBeTruthy();

			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await vi.advanceTimersByTimeAsync(0);
			await waitFor(() => {
				expect(localStorage.getItem("wiki-draft:w1")).toBeNull();
			});
		});
	});
});
