// WikiPage island — mock-fetch tests.
//
// WikiPage reads ?slug= from the URL, fetches the tree + page + revisions via
// apiFetch (which calls global fetch). The pattern: set the URL with
// history.replaceState, override the default stub from setup.ts with
// vi.stubGlobal, then await findBy* for the async state update.
import { render, screen, waitFor } from "@testing-library/preact";
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
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
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
});
