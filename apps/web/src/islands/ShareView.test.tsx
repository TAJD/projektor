// ShareView island — mock-fetch tests.
//
// ShareView is the public (unauthenticated) share-link view. It parses the
// token out of window.location.pathname (/share/:token), fetches
// /api/share/:token, and renders the issue or an error/expiry state. The
// pattern: set the pathname via history.pushState, stub fetch, render, and
// await the async result.
import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareView from "./ShareView";

const SHARED_ISSUE = {
	title: "Shared Bug Report",
	body: "## Steps to reproduce\n\n1. Do the thing",
	priority: "high",
	status_name: "In Review",
	status_category: "in_review",
	project_key: "PROJ",
	project_name: "Project",
	assignee_name: "Jane Doe",
	created_at: 1700000000,
	expires_at: 1700600000,
	customFields: [{ key: "story_points", label: "Story Points", type: "text", value: "5" }],
};

function setupFetch(body: unknown = SHARED_ISSUE, ok = true, status = 200) {
	return vi.fn().mockImplementation(() =>
		Promise.resolve({
			ok,
			status,
			json: () => Promise.resolve(body),
		})
	);
}

beforeEach(() => {
	history.pushState(null, "", "/share/tok-abc123");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	history.pushState(null, "", "/");
});

describe("ShareView — loading state", () => {
	it("shows a loading indicator before the fetch resolves", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ShareView />);
		expect(screen.getByText(/Loading/i)).toBeTruthy();
	});
});

describe("ShareView — data fetch/render path", () => {
	it("fetches /api/share/:token parsed from the URL path", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<ShareView />);

		await waitFor(() => {
			const calls = (mockFetch.mock.calls as [string, unknown][]).map(([u]) => String(u));
			expect(calls.some((u) => u.includes("/api/share/tok-abc123"))).toBe(true);
		});
	});

	it("renders the issue title, priority, status, and project", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<ShareView />);

		expect(await screen.findByText("Shared Bug Report")).toBeTruthy();
		expect(screen.getByText("High")).toBeTruthy();
		expect(screen.getByText("In Review")).toBeTruthy();
		expect(screen.getByText(/Project \(PROJ\)/)).toBeTruthy();
	});

	it("renders the assignee name and formatted created date", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<ShareView />);

		expect(await screen.findByText(/Assignee: Jane Doe/)).toBeTruthy();
		expect(screen.getByText(/Created Nov 14, 2023/)).toBeTruthy();
	});

	it("renders the markdown body as rendered HTML", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<ShareView />);

		await waitFor(() => expect(screen.getByText("Steps to reproduce")).toBeTruthy());
		expect(screen.getByText("Do the thing")).toBeTruthy();
	});

	it("shows 'No description.' when body is null", async () => {
		vi.stubGlobal("fetch", setupFetch({ ...SHARED_ISSUE, body: null }));
		render(<ShareView />);

		expect(await screen.findByText("No description.")).toBeTruthy();
	});

	it("renders custom fields when present", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<ShareView />);

		expect(await screen.findByText("Story Points")).toBeTruthy();
		expect(screen.getByText("5")).toBeTruthy();
	});

	it("omits the custom fields section when there are none", async () => {
		vi.stubGlobal("fetch", setupFetch({ ...SHARED_ISSUE, customFields: [] }));
		render(<ShareView />);

		await screen.findByText("Shared Bug Report");
		expect(screen.queryByText("Story Points")).toBeNull();
	});

	it("shows the expiry banner with the formatted expiry date", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<ShareView />);

		expect(await screen.findByText(/Shared view · Expires Nov 21, 2023/)).toBeTruthy();
	});
});

// Mermaid hydration (PROJ-447) — mirrors markdown.test.ts's mocked-mermaid approach,
// but through the island so we assert the effect actually wires up renderMermaidDiagrams.
describe("ShareView — mermaid hydration", () => {
	afterEach(() => {
		vi.doUnmock("mermaid");
		vi.resetModules();
	});

	it("hydrates a mermaid fence in the shared issue body", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { default: MockedShareView } = await import("./ShareView");

		vi.stubGlobal(
			"fetch",
			setupFetch({ ...SHARED_ISSUE, body: "```mermaid\ngraph TD\n    A --> B\n```" })
		);
		render(<MockedShareView />);

		await waitFor(() => {
			expect(run).toHaveBeenCalled();
		});
	});

	it("does not hydrate (mermaid.run is never called) for a body without a fence", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { default: MockedShareView } = await import("./ShareView");

		vi.stubGlobal("fetch", setupFetch());
		render(<MockedShareView />);

		await screen.findByText("Shared Bug Report");
		expect(run).not.toHaveBeenCalled();
	});
});

describe("ShareView — invalid link", () => {
	it("shows the generic error state when the URL path doesn't match /share/:token", async () => {
		history.pushState(null, "", "/not-a-share-link");
		vi.stubGlobal("fetch", vi.fn());
		render(<ShareView />);

		expect(await screen.findByText("Something went wrong")).toBeTruthy();
	});
});

describe("ShareView — expiry/error states", () => {
	it("shows the 'not found or expired' state on a 404 response", async () => {
		vi.stubGlobal("fetch", setupFetch({}, false, 404));
		render(<ShareView />);

		expect(await screen.findByText("Link not found or expired")).toBeTruthy();
		expect(screen.getByText(/valid for 3 days/i)).toBeTruthy();
	});

	it("shows the generic error state on a non-404 failure", async () => {
		vi.stubGlobal("fetch", setupFetch({}, false, 500));
		render(<ShareView />);

		expect(await screen.findByText("Something went wrong")).toBeTruthy();
	});

	it("provides a link back to the app in the error state", async () => {
		vi.stubGlobal("fetch", setupFetch({}, false, 404));
		render(<ShareView />);

		await screen.findByText("Link not found or expired");
		const link = screen.getByRole("link", { name: /Go to Projektor/i });
		expect(link.getAttribute("href")).toBe("/");
	});
});
