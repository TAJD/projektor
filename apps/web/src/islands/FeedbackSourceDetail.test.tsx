import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceDetail from "./FeedbackSourceDetail";

const SOURCE_A = {
	id: "s1",
	name: "Onboarding survey",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

const SOURCE_B = {
	id: "s2",
	name: "Widget",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "ffffff000000…",
	createdAt: 900,
	revokedAt: null,
};

function stubFetch(sources = [SOURCE_A, SOURCE_B]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/feedback-sources")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			if (u.includes("/feedback/summary")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/feedback")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/api/projects")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve([{ id: "p1", name: "Project 1" }]),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		})
	);
}

describe("FeedbackSourceDetail", () => {
	it("renders the source name, status, and a source-switch dropdown", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect(await screen.findByRole("heading", { name: "Onboarding survey" })).toBeTruthy();
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.getByRole("combobox", { name: /Switch feedback source/i })).toBeTruthy();
	});

	it("defaults to the Items tab and shows a tablist with three tabs", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByRole("heading", { name: "Onboarding survey" });
		expect(screen.getByRole("tab", { name: "Items", selected: true })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
	});

	it("switching to the Settings tab renders token/status controls", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByRole("heading", { name: "Onboarding survey" });
		fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
		expect(await screen.findByText("abcdef012345…")).toBeTruthy();
	});

	it("shows a not-found state for an unknown sourceId", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="does-not-exist" />);
		expect(await screen.findByText(/Feedback source not found/i)).toBeTruthy();
	});

	it("resolves sourceId from ?sourceId= when not passed as a prop (static /feedback/view page)", async () => {
		stubFetch();
		const originalPath = window.location.pathname;
		const originalSearch = window.location.search;
		window.history.pushState({}, "", "/feedback/view?sourceId=s2");
		try {
			render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" />);
			expect(await screen.findByRole("heading", { name: "Widget" })).toBeTruthy();
		} finally {
			window.history.pushState({}, "", originalPath + originalSearch);
		}
	});

	it("resolves sourceId from the pathname when not passed as a prop (SPA-fallback serving)", async () => {
		stubFetch();
		const originalPath = window.location.pathname;
		window.history.pushState({}, "", "/feedback/s2");
		try {
			render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" />);
			expect(await screen.findByRole("heading", { name: "Widget" })).toBeTruthy();
		} finally {
			window.history.pushState({}, "", originalPath);
		}
	});

	it("resolves projectId from localStorage or /api/projects when no projectId prop or query param is present", async () => {
		stubFetch();
		const originalPath = window.location.pathname;
		window.history.pushState({}, "", "/feedback/s1");
		localStorage.removeItem("projektor-last-project-id");
		try {
			render(<FeedbackSourceDetail workspaceSlug="my-ws" />);
			expect(await screen.findByRole("heading", { name: "Onboarding survey" })).toBeTruthy();
		} finally {
			window.history.pushState({}, "", originalPath);
		}
	});

	it("switching sources via the dropdown navigates to the new source's detail page", async () => {
		stubFetch();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			value: { ...originalLocation, href: "" },
			writable: true,
		});
		try {
			render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
			await screen.findByRole("heading", { name: "Onboarding survey" });
			fireEvent.click(screen.getByRole("combobox", { name: /Switch feedback source/i }));
			fireEvent.click(screen.getByRole("option", { name: "Widget" }));
			await waitFor(() => expect(window.location.href).toContain("/feedback/s2"));
		} finally {
			Object.defineProperty(window, "location", { value: originalLocation, writable: true });
		}
	});
});
