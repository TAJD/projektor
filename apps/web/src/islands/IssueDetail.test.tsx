import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IssueDetail from "./IssueDetail";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EPIC_DATA = {
	id: "epic-1",
	number: 5,
	title: "Big Epic",
	body: null,
	priority: "high",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Project",
	type_key: "epic",
	type_name: "Epic",
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

const CHILD_ISSUE_DATA = {
	id: "child-1",
	number: 6,
	title: "Child Task",
	body: null,
	priority: "medium",
	assignee_id: null,
	assignee_name: null,
	parent_id: "epic-1",
	project_key: "PROJ",
	project_name: "Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

const PLAIN_ISSUE_DATA = {
	id: "plain-1",
	number: 7,
	title: "Plain Task",
	body: null,
	priority: "low",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

const STORY_PARENT_DATA = {
	id: "story-1",
	number: 3,
	title: "A Story",
	body: null,
	priority: "medium",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Project",
	type_key: "story",
	type_name: "Story",
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

const CHILD_OF_STORY_DATA = {
	id: "child-2",
	number: 8,
	title: "Task Under Story",
	body: null,
	priority: "low",
	assignee_id: null,
	assignee_name: null,
	parent_id: "story-1",
	project_key: "PROJ",
	project_name: "Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

interface IssueFixture {
	id: string;
	number: number;
	title: string;
	body: string | null;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	parent_id: string | null;
	project_key: string | null;
	project_name: string | null;
	type_key: string | null;
	type_name: string | null;
	status_id: string | null;
	status_key: string | null;
	status_name: string | null;
	status_category: string | null;
	created_at: number;
	updated_at: number;
	customFields: unknown[];
}

function setupFetch(issueData: IssueFixture, parentData?: IssueFixture) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/comments")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/links")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("task-statuses")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			// Parent fetch: /api/issues/<parent_id>
			if (parentData && issueData.parent_id && u.endsWith(`/api/issues/${issueData.parent_id}`)) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(parentData) });
			}
			// Child list
			if (u.includes("?parentId=")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
			}
			// Main issue
			return Promise.resolve({ ok: true, json: () => Promise.resolve(issueData) });
		})
	);
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
	localStorage.clear();
	history.replaceState(null, "", "/");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

// ─── Parent badge ─────────────────────────────────────────────────────────────

describe("parent badge in IssueDetail", () => {
	it("shows the parent badge with epic styling when the parent type_key is 'epic'", async () => {
		setupFetch(CHILD_ISSUE_DATA, EPIC_DATA);
		render(<IssueDetail issueId="child-1" />);

		await waitFor(() => {
			expect(screen.getByText(/Epic:/i)).toBeDefined();
			expect(screen.getByText(/PROJ-5/)).toBeDefined();
			expect(screen.getByText(/Big Epic/)).toBeDefined();
		});
	});

	it("does not show any parent badge when the issue has no parent", async () => {
		setupFetch(PLAIN_ISSUE_DATA);
		render(<IssueDetail issueId="plain-1" />);

		await waitFor(() => screen.getByText("Plain Task"));

		expect(screen.queryByText(/Epic:/i)).toBeNull();
		expect(screen.queryByText(/Story:/i)).toBeNull();
	});

	it("shows the parent badge for a non-epic parent using the parent's type_name", async () => {
		setupFetch(CHILD_OF_STORY_DATA, STORY_PARENT_DATA);
		render(<IssueDetail issueId="child-2" />);

		await waitFor(() => {
			expect(screen.getByText(/Story:/i)).toBeDefined();
			expect(screen.getByText(/PROJ-3/)).toBeDefined();
			expect(screen.getByText(/A Story/)).toBeDefined();
		});

		// Epic-specific text must not appear
		expect(screen.queryByText(/Epic:/i)).toBeNull();
	});
});

// ─── URL path parsing ─────────────────────────────────────────────────────────

describe("URL path parsing (pretty-URL fallback)", () => {
	it("resolves issue from /projects/KEY/issues/N/title when no issueId prop is provided", async () => {
		history.replaceState(null, "", "/projects/PROJ/issues/87/some-title");

		const mockFetch = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/comments"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.includes("/links"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.includes("task-statuses"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			if (u.includes("?parentId="))
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
			// Ref lookup: GET /api/issues/PROJ-87 → returns the UUID
			if (u.endsWith("/api/issues/PROJ-87")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "plain-1" }) });
			}
			// Full issue fetch by UUID
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PLAIN_ISSUE_DATA) });
		});
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueDetail />);

		expect(await screen.findByText("Plain Task")).toBeTruthy();

		// The ref-lookup call must have been made
		const calls = (mockFetch.mock.calls as [string, unknown][]).map(([u]) => String(u));
		expect(calls.some((u) => u.endsWith("/api/issues/PROJ-87"))).toBe(true);
	});

	it("does NOT parse the URL path when an issueId prop is already provided", async () => {
		history.replaceState(null, "", "/projects/OTHER/issues/99/ignore-this");

		const mockFetch = makeFetchForDetail(PLAIN_ISSUE_DATA);
		vi.stubGlobal("fetch", mockFetch);

		// issueId prop supplied directly — path must be ignored
		render(<IssueDetail issueId="plain-1" />);

		await waitFor(() => screen.getByText("Plain Task"));

		const calls = (mockFetch.mock.calls as [string, unknown][]).map(([u]) => String(u));
		expect(calls.some((u) => u.endsWith("/api/issues/OTHER-99"))).toBe(false);
	});
});

// ─── PROJ-98: workspace-slug header contract ──────────────────────────────────

function makeFetchForDetail(issueData: IssueFixture) {
	return vi.fn().mockImplementation((url: string) => {
		const u = String(url);
		if (u.includes("/comments"))
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		if (u.includes("/links")) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		if (u.includes("task-statuses"))
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		if (u.includes("?parentId="))
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
		return Promise.resolve({ ok: true, json: () => Promise.resolve(issueData) });
	});
}

// ─── PROJ-226: tab title reflects the loaded issue ────────────────────────────

describe("document title (PROJ-226)", () => {
	it("sets the tab title to '<ref> - <title>' once the issue loads", async () => {
		setupFetch(PLAIN_ISSUE_DATA);
		render(<IssueDetail issueId="plain-1" />);

		await waitFor(() => {
			expect(document.title).toBe("PROJ-7 - Plain Task");
		});
	});
});

describe("workspace-slug header contract (PROJ-98)", () => {
	it("includes X-Workspace-Slug header when workspaceSlug prop is passed", async () => {
		const mockFetch = makeFetchForDetail(PLAIN_ISSUE_DATA);
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueDetail issueId="plain-1" workspaceSlug="my-workspace" />);
		await waitFor(() => screen.getByText("Plain Task"));

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		// Every call must carry the slug; spot-check the primary issue fetch
		const issueCall = calls.find(
			([url]) => String(url).includes("/api/issues/plain-1") && !String(url).includes("?")
		);
		expect(issueCall).toBeDefined();
		const headers = (issueCall?.[1].headers as Record<string, string>) ?? {};
		expect(headers["X-Workspace-Slug"]).toBe("my-workspace");
	});

	it("omits X-Workspace-Slug header when workspaceSlug prop is not passed", async () => {
		const mockFetch = makeFetchForDetail(PLAIN_ISSUE_DATA);
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueDetail issueId="plain-1" />);
		await waitFor(() => screen.getByText("Plain Task"));

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBeUndefined();
		}
	});

	it("does NOT read workspace slug from localStorage — stale value never appears in fetch headers", async () => {
		localStorage.setItem("workspace-slug", "stale-slug");

		const mockFetch = makeFetchForDetail(PLAIN_ISSUE_DATA);
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueDetail issueId="plain-1" workspaceSlug="real-slug" />);
		await waitFor(() => screen.getByText("Plain Task"));

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).not.toBe("stale-slug");
			if (headers["X-Workspace-Slug"] !== undefined) {
				expect(headers["X-Workspace-Slug"]).toBe("real-slug");
			}
		}
	});
});
