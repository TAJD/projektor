import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceManager from "./FeedbackSourceManager";

const SOURCE = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

function stubFetch(sources = [SOURCE]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/feedback-sources") && (init?.method ?? "GET") === "GET") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			if (u.includes("/feedback-sources") && init?.method === "POST") {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ id: "s2", token: "fbk_rawtoken_shown_once" }),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		})
	);
}

describe("FeedbackSourceManager", () => {
	it("lists sources with name and token preview after fetch", async () => {
		stubFetch();
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		expect((await screen.findAllByText("Onboarding survey")).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/abcdef012345/).length).toBeGreaterThan(0);
	});

	it("renders a mobile-card fallback alongside the desktop table", async () => {
		stubFetch();
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		// Desktop table + mobile card both render (CSS hides one per viewport).
		expect((await screen.findAllByText("Onboarding survey")).length).toBe(2);
	});

	it("shows the raw token once after minting a source", async () => {
		stubFetch([]);
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText(/No feedback sources yet/i);
		fireEvent.click(screen.getByRole("button", { name: /New source/i }));
		fireEvent.input(await screen.findByLabelText(/Name/i), { target: { value: "NPS" } });
		fireEvent.click(screen.getByRole("button", { name: /Create source/i }));
		expect(await screen.findByText("fbk_rawtoken_shown_once")).toBeTruthy();
		expect(screen.getByText(/won't be able to see it again/i)).toBeTruthy();
	});

	it("renders an access-denied notice on a 403 list response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
				)
		);
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText(/Only workspace owners and admins/i)).toBeTruthy();
	});

	it("falls back to projectId from the URL when no prop is passed", async () => {
		// Regression: feedback.astro is prerendered under `output: 'static'`, so
		// Astro.url.searchParams is always empty and can't supply projectId as a
		// prop. The island must resolve it from window.location.search itself.
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			value: { ...originalLocation, search: "?projectId=p1" },
			writable: true,
		});
		stubFetch();
		try {
			render(<FeedbackSourceManager workspaceSlug="my-ws" />);
			expect((await screen.findAllByText("Onboarding survey")).length).toBeGreaterThan(0);
			const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
			expect(fetchMock.mock.calls[0][0]).toContain("/api/projects/p1/feedback-sources");
		} finally {
			Object.defineProperty(window, "location", { value: originalLocation, writable: true });
		}
	});
});
