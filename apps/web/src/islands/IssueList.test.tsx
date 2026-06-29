import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, TaskStatus } from "./board-utils";
import IssueList from "./IssueList";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STATUSES: TaskStatus[] = [
	{ id: "st-todo", key: "todo", name: "Todo", category: "todo", color: null },
	{ id: "st-done", key: "done", name: "Done", category: "done", color: null },
];

const ISSUES: Issue[] = [
	{
		id: "i1",
		number: 1,
		title: "Alpha issue",
		priority: "high",
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
		sprint_id: null,
		updated_at: 1000,
		created_at: 1000,
	},
	{
		id: "i2",
		number: 2,
		title: "Beta issue",
		priority: "low",
		assignee_id: null,
		assignee_name: null,
		parent_id: null,
		project_key: "PROJ",
		project_name: "Project",
		type_key: null,
		type_name: null,
		status_id: "st-done",
		status_key: "done",
		status_name: "Done",
		status_category: "done",
		sprint_id: null,
		updated_at: 2000,
		created_at: 1000,
	},
];

// Epic filter fixtures: one epic, one child, one orphan regular issue
const EPIC_ISSUE: Issue = {
	id: "epic1",
	number: 10,
	title: "Epic One",
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
	sprint_id: null,
	updated_at: 1000,
	created_at: 1000,
};

const CHILD_ISSUE: Issue = {
	id: "child1",
	number: 11,
	title: "Child of Epic",
	priority: "medium",
	assignee_id: null,
	assignee_name: null,
	parent_id: "epic1",
	project_key: "PROJ",
	project_name: "Project",
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

const ORPHAN_ISSUE: Issue = {
	id: "orphan1",
	number: 12,
	title: "Orphan issue",
	priority: "low",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Project",
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

const EPIC_ISSUES = [EPIC_ISSUE, CHILD_ISSUE, ORPHAN_ISSUE];

function setupFetch(issues = ISSUES, statuses = STATUSES) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) =>
			Promise.resolve({
				ok: true,
				json: () =>
					Promise.resolve(String(url).includes("task-statuses") ? statuses : { items: issues }),
			})
		)
	);
}

/** Wait until the loading state is gone (view-mode buttons appear post-load). */
async function waitForLoaded() {
	await waitFor(() => screen.getByRole("button", { name: "list" }));
}

/** Open the Filters popover so status/priority pills become accessible. */
function openFiltersPopover() {
	fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
	localStorage.clear();
	history.replaceState(null, "", "/");
	setupFetch();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	history.replaceState(null, "", "/");
});

// ─── PROJ-60: view-mode localStorage round-trip ───────────────────────────────

describe("view-mode localStorage round-trip", () => {
	it("reads view from localStorage on mount — board persists across remount", async () => {
		localStorage.setItem("issues-view", "board");
		render(<IssueList />);
		await waitForLoaded();

		const boardBtn = screen.getByRole("button", { name: "board" });
		expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
	});

	it("persists view selection to localStorage when changed", async () => {
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(screen.getByRole("button", { name: "board" }));
		await waitFor(() => expect(localStorage.getItem("issues-view")).toBe("board"));

		// Unmount and remount — new instance should read the stored value
		cleanup();
		setupFetch();
		render(<IssueList />);
		await waitForLoaded();

		expect(screen.getByRole("button", { name: "board" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "list" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("defaults to list view when localStorage has no issues-view key", async () => {
		render(<IssueList />);
		await waitForLoaded();

		expect(screen.getByRole("button", { name: "list" }).getAttribute("aria-pressed")).toBe("true");
	});
});

// ─── PROJ-60: URL ↔ filter sync ───────────────────────────────────────────────

describe("URL ↔ filter sync", () => {
	it("reads ?status= from URL on mount and activates the matching pill", async () => {
		history.replaceState(null, "", "/?status=st-todo");
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		// The 'Todo' status pill (id=st-todo) should be active
		await waitFor(() => {
			const pill = screen.getByRole("button", { name: "Todo" });
			expect(pill.getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("reads ?priority= from URL on mount and activates the matching pill", async () => {
		history.replaceState(null, "", "/?priority=high");
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "high" }).getAttribute("aria-pressed")).toBe(
				"true"
			);
		});
	});

	it("writes active priority filter to URL via history.replaceState", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		fireEvent.click(screen.getByRole("button", { name: "urgent" }));

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("priority")).toBe("urgent");
		});
	});

	it("writes active status filter to URL via history.replaceState", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		fireEvent.click(screen.getByRole("button", { name: "Todo" }));

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("status")).toBe("st-todo");
		});
	});

	it("removes the status param from URL when filter is cleared", async () => {
		history.replaceState(null, "", "/?status=st-todo");
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		// Deactivate the Todo pill
		const todoPill = screen.getByRole("button", { name: "Todo" });
		fireEvent.click(todoPill);

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("status")).toBeNull();
		});
	});
});

// ─── PROJ-60: filter pill toggle ─────────────────────────────────────────────

describe("filter pill toggle", () => {
	it("activates a status pill on click (inactive → active)", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		const pill = screen.getByRole("button", { name: "Todo" });
		expect(pill.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(pill);
		await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));
	});

	it("deactivates an active status pill on second click (active → inactive)", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		const pill = screen.getByRole("button", { name: "Todo" });
		fireEvent.click(pill);
		await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));

		fireEvent.click(pill);
		await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("false"));
	});

	it("activates a priority pill on click (inactive → active)", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		const pill = screen.getByRole("button", { name: "high" });
		expect(pill.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(pill);
		await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));
	});

	it("Clear button resets both status and priority filters", async () => {
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		fireEvent.click(screen.getByRole("button", { name: "Todo" }));
		fireEvent.click(screen.getByRole("button", { name: "high" }));

		// Clear button should appear once any filter is active
		const clearBtn = await screen.findByRole("button", { name: /clear/i });
		fireEvent.click(clearBtn);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Todo" }).getAttribute("aria-pressed")).toBe(
				"false"
			);
			expect(screen.getByRole("button", { name: "high" }).getAttribute("aria-pressed")).toBe(
				"false"
			);
		});

		// Clear button should disappear after reset
		expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
	});

	it("Clear button does not appear when no filters are active", async () => {
		render(<IssueList />);
		await waitForLoaded();

		expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
	});
});

// ─── PROJ-84/86: epic filter ──────────────────────────────────────────────────

describe("epic filter", () => {
	beforeEach(() => {
		setupFetch(EPIC_ISSUES);
	});

	it("filtering by a specific epic ID shows only issues that are children of that epic", async () => {
		render(<IssueList />);
		await waitForLoaded();

		// Select uses a custom combobox (button + listbox) — must click to open then click option
		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "PROJ-10 Epic One" }));

		await waitFor(() => {
			expect(screen.getAllByText("Child of Epic").length).toBeGreaterThan(0);
			expect(screen.queryAllByText("Orphan issue")).toHaveLength(0);
			expect(screen.queryAllByText("Epic One")).toHaveLength(0);
		});
	});

	it("the 'No epic' filter shows only issues with parent_id null that are not themselves epics", async () => {
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "No epic" }));

		await waitFor(() => {
			expect(screen.getAllByText("Orphan issue").length).toBeGreaterThan(0);
			expect(screen.queryAllByText("Child of Epic")).toHaveLength(0);
			// The epic itself (parent_id null, type_key "epic") should not appear
			expect(screen.queryAllByText("Epic One")).toHaveLength(0);
		});
	});

	it("clearing the epic filter restores the full list", async () => {
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "PROJ-10 Epic One" }));
		await waitFor(() => expect(screen.queryAllByText("Orphan issue")).toHaveLength(0));

		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "All epics" }));

		await waitFor(() => {
			expect(screen.getAllByText("Epic One").length).toBeGreaterThan(0);
			expect(screen.getAllByText("Child of Epic").length).toBeGreaterThan(0);
			expect(screen.getAllByText("Orphan issue").length).toBeGreaterThan(0);
		});
	});

	it("writes the epic filter to URL when a specific epic is selected", async () => {
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "PROJ-10 Epic One" }));

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("epic")).toBe("epic1");
		});
	});

	it("reads ?epic= from URL on mount and pre-selects the epic filter", async () => {
		history.replaceState(null, "", "/?epic=epic1");
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => {
			expect(screen.queryAllByText("Orphan issue")).toHaveLength(0);
			expect(screen.getAllByText("Child of Epic").length).toBeGreaterThan(0);
		});
	});

	it("removes the epic param from URL when filter is reset to all", async () => {
		history.replaceState(null, "", "/?epic=epic1");
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(screen.getByRole("combobox", { name: "Filter by epic" }));
		fireEvent.click(await screen.findByRole("option", { name: "All epics" }));

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("epic")).toBeNull();
		});
	});
});

// ─── PROJ-98: workspace-slug header contract ──────────────────────────────────

function makeFetch(overrideIssues = ISSUES) {
	return vi.fn().mockImplementation((url: string) =>
		Promise.resolve({
			ok: true,
			json: () =>
				Promise.resolve(
					String(url).includes("task-statuses") ? STATUSES : { items: overrideIssues }
				),
		})
	);
}

describe("workspace-slug header contract (PROJ-98)", () => {
	it("includes X-Workspace-Slug header when workspaceSlug prop is passed", async () => {
		const mockFetch = makeFetch();
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueList workspaceSlug="my-workspace" />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		const issueCall = calls.find(([url]) => String(url).includes("/api/issues"));
		expect(issueCall).toBeDefined();
		const headers = (issueCall?.[1].headers as Record<string, string>) ?? {};
		expect(headers["X-Workspace-Slug"]).toBe("my-workspace");
	});

	it("omits X-Workspace-Slug header when workspaceSlug prop is not passed", async () => {
		const mockFetch = makeFetch();
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueList />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBeUndefined();
		}
	});

	it("does NOT read workspace slug from localStorage — stale localStorage value never appears in fetch headers", async () => {
		// Simulate a stale localStorage entry from the old WorkspaceSwitcher pattern (removed in PR #59)
		localStorage.setItem("workspace-slug", "stale-slug");

		const mockFetch = makeFetch();
		vi.stubGlobal("fetch", mockFetch);

		render(<IssueList workspaceSlug="real-slug" />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			// The stale localStorage value must never reach the wire
			expect(headers["X-Workspace-Slug"]).not.toBe("stale-slug");
			// When the header is present it must be the prop value
			if (headers["X-Workspace-Slug"] !== undefined) {
				expect(headers["X-Workspace-Slug"]).toBe("real-slug");
			}
		}
	});
});

// ─── Project filter API contract ─────────────────────────────────────────────

const PROJECTS = [{ id: "proj-1", key: "PROJ", name: "Project", description: null }];

function setupProjectFetch(projects = PROJECTS, issues = ISSUES) {
	const mock = vi.fn().mockImplementation((url: string) => {
		const s = String(url);
		if (s.includes("task-statuses"))
			return Promise.resolve({ ok: true, json: () => Promise.resolve(STATUSES) });
		if (s.includes("/api/projects"))
			return Promise.resolve({ ok: true, json: () => Promise.resolve(projects) });
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

describe("project filter API contract", () => {
	it("issues fetch uses the default 30-row page in list view (PROJ-201)", async () => {
		const mockFetch = setupProjectFetch();
		render(<IssueList />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		const issueCall = calls.find(([url]) => String(url).includes("/api/issues"));
		expect(issueCall).toBeDefined();
		expect(String(issueCall![0])).toContain("limit=30");
	});

	it("includes project=<id> in issues fetch when ?project=KEY is active", async () => {
		history.replaceState(null, "", "/?project=PROJ");
		const mockFetch = setupProjectFetch();
		render(<IssueList />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		await waitFor(() => {
			const projectCall = calls.find(([url]) => String(url).includes("project=proj-1"));
			expect(projectCall).toBeDefined();
		});

		const projectCall = calls.find(([url]) => String(url).includes("project=proj-1"));
		expect(String(projectCall![0])).toContain("limit=30");
	});

	it("does not include project param when no project filter is set", async () => {
		const mockFetch = setupProjectFetch();
		render(<IssueList />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		const issueCalls = calls.filter(([url]) => String(url).includes("/api/issues"));
		for (const [url] of issueCalls) {
			expect(String(url)).not.toContain("project=");
		}
	});
});

// ─── Sprint banner ────────────────────────────────────────────────────────────

const SPRINT_DETAIL = {
	id: "spr-1",
	name: "Sprint 1",
	status: "active" as const,
	startDate: 1700000000,
	endDate: 1700600000,
	goal: "Ship the feature",
	projectId: "proj-abc",
};

const SPRINT_ISSUES: Issue[] = [
	{ ...ISSUES[0], sprint_id: "spr-1", status_category: "todo" },
	{ ...ISSUES[1], sprint_id: "spr-1", status_category: "done" },
];

function setupSprintFetch(sprintDetail = SPRINT_DETAIL, issues = SPRINT_ISSUES) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const s = String(url);
			if (s.includes("task-statuses"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve(STATUSES) });
			if (s.match(/\/api\/sprints\/[^?]+$/) && !s.includes("projectId"))
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sprintDetail) });
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
		})
	);
}

describe("sprint banner", () => {
	beforeEach(() => {
		history.replaceState(null, "", "/?sprintId=spr-1");
		setupSprintFetch();
	});

	it("shows sprint name and status badge when ?sprintId= is in the URL", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => {
			expect(screen.getByText("Sprint 1")).toBeDefined();
			expect(screen.getByText("active")).toBeDefined();
		});
	});

	it("shows sprint goal text in the banner", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => {
			expect(screen.getByText("Ship the feature")).toBeDefined();
		});
	});

	it("shows issue progress stats (done/total)", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => {
			expect(screen.getByText("1/2 done")).toBeDefined();
		});
	});

	it("clears the sprint filter when the Clear sprint button is clicked", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => screen.getByText("Sprint 1"));
		fireEvent.click(screen.getByRole("button", { name: /clear sprint/i }));

		await waitFor(() => {
			expect(screen.queryByText("Sprint 1")).toBeNull();
			const params = new URLSearchParams(window.location.search);
			expect(params.get("sprintId")).toBeNull();
		});
	});

	it("opens the edit form when the Edit button is clicked", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => screen.getByText("Sprint 1"));
		fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /^save$/i })).toBeDefined();
			expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
		});
	});

	it("cancelling the edit form returns to the view mode", async () => {
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => screen.getByText("Sprint 1"));
		fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
		await waitFor(() => screen.getByRole("button", { name: /cancel/i }));

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		await waitFor(() => {
			expect(screen.getByText("Sprint 1")).toBeDefined();
			expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
		});
	});
});
