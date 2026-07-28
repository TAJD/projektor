// MyIssues island — mock-fetch tests.
//
// MyIssues fetches /api/issues?assignee=me (server-resolved to the calling
// user, PROJ-444) and groups the results by project. The pattern: stub
// global fetch to branch on URL, render, and await the post-load UI
// (view-mode buttons in IssueList's pattern don't apply here — instead wait
// for the "Include done" checkbox which only renders post-load).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "./board-utils";
import MyIssues from "./MyIssues";

const USER_ID = "user-1";

const OPEN_ISSUE_PROJ_A: Issue = {
	id: "i1",
	number: 1,
	title: "Open issue in Alpha",
	priority: "high",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "ALPHA",
	project_name: "Alpha Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	sprint_id: null,
	updated_at: 1000,
	created_at: 1000,
};

const DONE_ISSUE_PROJ_A: Issue = {
	id: "i2",
	number: 2,
	title: "Done issue in Alpha",
	priority: "low",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "ALPHA",
	project_name: "Alpha Project",
	type_key: null,
	type_name: null,
	status_id: "st-done",
	status_key: "done",
	status_name: "Done",
	status_category: "done",
	sprint_id: null,
	updated_at: 2000,
	created_at: 1000,
};

const OPEN_ISSUE_PROJ_B: Issue = {
	id: "i3",
	number: 5,
	title: "Open issue in Beta",
	priority: "medium",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "BETA",
	project_name: "Beta Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	sprint_id: null,
	updated_at: 1500,
	created_at: 1000,
};

function setupFetch(issues: Issue[] = [OPEN_ISSUE_PROJ_A, DONE_ISSUE_PROJ_A, OPEN_ISSUE_PROJ_B]) {
	return vi.fn().mockImplementation((url: string) => {
		const u = String(url);
		if (u.includes("/api/issues")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
		}
		return Promise.reject(new Error(`unexpected fetch: ${u}`));
	});
}

async function waitForLoaded() {
	await waitFor(() => screen.getByLabelText(/Include done/i));
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("MyIssues — loading and error states", () => {
	it("shows a loading indicator before data resolves", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<MyIssues />);
		expect(screen.getByText(/Loading/i)).toBeTruthy();
	});

	it("shows an error message when the issues fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => Promise.reject(new Error("boom")))
		);
		render(<MyIssues />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Failed to load issues/i)).toBeTruthy();
	});
});

describe("MyIssues — cross-project fetch and grouping", () => {
	it("fetches issues scoped to assignee=me (server resolves the calling user)", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);
		await waitForLoaded();

		const calls = (mockFetch.mock.calls as [string, unknown][]).map(([u]) => String(u));
		expect(calls.some((u) => u.includes("/api/issues?assignee=me"))).toBe(true);
	});

	it("groups issues by project under a heading per project", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		// Titles render twice (desktop table + mobile card, toggled via CSS), so
		// assert on the unique project heading and count of title occurrences.
		expect(await screen.findByText("Alpha Project")).toBeTruthy();
		expect(screen.getByText("Beta Project")).toBeTruthy();
		expect(screen.getAllByText("Open issue in Alpha").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Open issue in Beta").length).toBeGreaterThan(0);
	});

	it("hides done issues by default", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		await waitFor(() =>
			expect(screen.getAllByText("Open issue in Alpha").length).toBeGreaterThan(0)
		);
		expect(screen.queryAllByText("Done issue in Alpha")).toHaveLength(0);
	});

	it("shows done issues once 'Include done' is checked", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		fireEvent.click(screen.getByLabelText(/Include done/i));

		await waitFor(() =>
			expect(screen.getAllByText("Done issue in Alpha").length).toBeGreaterThan(0)
		);
	});

	it("shows the issue count reflecting the current filter", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		await waitFor(() => expect(screen.getByText("2 issues")).toBeTruthy());

		fireEvent.click(screen.getByLabelText(/Include done/i));
		await waitFor(() => expect(screen.getByText("3 issues")).toBeTruthy());
	});
});

describe("MyIssues — empty states", () => {
	it("shows the open-issues empty state when there are no assigned issues", async () => {
		vi.stubGlobal("fetch", setupFetch([]));
		render(<MyIssues />);
		await waitForLoaded();

		expect(await screen.findByText("No issues assigned to you")).toBeTruthy();
		expect(screen.getByText(/Toggle "Include done"/i)).toBeTruthy();
	});

	it("shows the all-projects empty state once 'Include done' is toggled with no issues at all", async () => {
		vi.stubGlobal("fetch", setupFetch([]));
		render(<MyIssues />);
		await waitForLoaded();

		fireEvent.click(screen.getByLabelText(/Include done/i));

		await waitFor(() =>
			expect(screen.getByText("You have no issues across any project.")).toBeTruthy()
		);
	});
});

describe("MyIssues — workspace-slug header contract", () => {
	it("includes X-Workspace-Slug header when workspaceSlug prop is passed", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues workspaceSlug="my-workspace" />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBe("my-workspace");
		}
	});

	it("omits X-Workspace-Slug header when workspaceSlug prop is not passed", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBeUndefined();
		}
	});
});
