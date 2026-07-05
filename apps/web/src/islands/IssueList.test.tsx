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

// ─── PROJ-84/86/211: epic filter (server-side) ───────────────────────────────
//
// Filtering runs server-side (PROJ-211): the island sends query params and the
// API filters. These tests assert the request contract — that the right params
// reach /api/issues — not client-side DOM filtering (the mock returns a fixed
// set regardless of params, exactly as a real server boundary would hide from
// the client). The epic dropdown is also fetched independently (typeId=epic),
// so it must be awaited rather than read synchronously.

function setupEpicFetch() {
	const mockFetch = vi.fn().mockImplementation((url: string) => {
		const u = String(url);
		let body: unknown;
		if (u.includes("task-statuses")) body = STATUSES;
		else if (u.includes("task-types")) body = [{ id: "type-epic", key: "epic", name: "Epic" }];
		else if (u.includes("/api/projects")) body = [];
		else if (u.includes("typeId=type-epic"))
			body = { items: [EPIC_ISSUE] }; // epic-dropdown lookup
		else body = { items: EPIC_ISSUES }; // main list
		return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
	});
	vi.stubGlobal("fetch", mockFetch);
	return mockFetch;
}

/** Latest /api/issues *list* request URL (excludes the epic-dropdown lookup). */
function lastListUrl(mockFetch: ReturnType<typeof vi.fn>): string {
	const urls = (mockFetch.mock.calls as [string, RequestInit][])
		.map((c) => String(c[0]))
		.filter((u) => u.includes("/api/issues") && !u.includes("typeId=type-epic"));
	return urls[urls.length - 1] ?? "";
}

async function selectEpicOption(name: string) {
	fireEvent.click(await screen.findByRole("combobox", { name: "Filter by epic" }));
	fireEvent.click(await screen.findByRole("option", { name }));
}

describe("epic filter (server-side, PROJ-211)", () => {
	it("sends parentId when a specific epic is selected", async () => {
		const mockFetch = setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await selectEpicOption("PROJ-10 Epic One");

		await waitFor(() => expect(lastListUrl(mockFetch)).toContain("parentId=epic1"));
	});

	it("sends noParent + excludeTypeIds for the 'No epic' option", async () => {
		const mockFetch = setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await selectEpicOption("No epic");

		await waitFor(() => {
			const url = lastListUrl(mockFetch);
			expect(url).toContain("noParent=true");
			expect(url).toContain("excludeTypeIds=type-epic");
		});
	});

	it("sends neither parentId nor noParent when reset to all epics", async () => {
		const mockFetch = setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await selectEpicOption("PROJ-10 Epic One");
		await waitFor(() => expect(lastListUrl(mockFetch)).toContain("parentId=epic1"));

		await selectEpicOption("All epics");
		await waitFor(() => {
			const url = lastListUrl(mockFetch);
			expect(url).not.toContain("parentId=");
			expect(url).not.toContain("noParent=");
		});
	});

	it("writes the epic filter to URL when a specific epic is selected", async () => {
		setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await selectEpicOption("PROJ-10 Epic One");

		await waitFor(() =>
			expect(new URLSearchParams(window.location.search).get("epic")).toBe("epic1")
		);
	});

	it("reads ?epic= from URL on mount and sends parentId on the first fetch", async () => {
		history.replaceState(null, "", "/?epic=epic1");
		const mockFetch = setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => expect(lastListUrl(mockFetch)).toContain("parentId=epic1"));
	});

	it("removes the epic param from URL when filter is reset to all", async () => {
		history.replaceState(null, "", "/?epic=epic1");
		setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		await selectEpicOption("All epics");

		await waitFor(() => expect(new URLSearchParams(window.location.search).get("epic")).toBeNull());
	});
});

describe("hide epics (server-side, PROJ-211)", () => {
	it("sends excludeTypeIds for the epic type when 'Hide epics' is checked", async () => {
		const mockFetch = setupEpicFetch();
		render(<IssueList />);
		await waitForLoaded();

		fireEvent.click(await screen.findByRole("checkbox", { name: /Hide epics/i }));

		await waitFor(() => expect(lastListUrl(mockFetch)).toContain("excludeTypeIds=type-epic"));
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

	it("does NOT read workspace slug from localStorage — stale value never appears in fetch headers", async () => {
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
		expect(String(issueCall?.[0])).toContain("limit=30");
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
		expect(String(projectCall?.[0])).toContain("limit=30");
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

// ─── PROJ-212: date-range filter (server-side) ───────────────────────────────
//
// The range bounds run server-side: the island converts the chosen field +
// from/to dates into completed*/updated* query params. These assert the request
// contract reaching /api/issues, not client-side filtering.

function setupDateFetch() {
	const mock = vi.fn().mockImplementation((url: string) =>
		Promise.resolve({
			ok: true,
			json: () =>
				Promise.resolve(String(url).includes("task-statuses") ? STATUSES : { items: ISSUES }),
		})
	);
	vi.stubGlobal("fetch", mock);
	return mock;
}

/** Latest /api/issues list request URL. */
function lastIssuesUrl(mock: ReturnType<typeof vi.fn>): string {
	const urls = (mock.mock.calls as [string, RequestInit][])
		.map((c) => String(c[0]))
		.filter((u) => u.includes("/api/issues"));
	return urls[urls.length - 1] ?? "";
}

/** Renders IssueList, opens the filters popover, and sets a "Completed" From-date filter. */
async function setupCompletedFromDateFilter() {
	const mock = setupDateFetch();
	render(<IssueList />);
	await waitForLoaded();
	openFiltersPopover();

	fireEvent.change(screen.getByRole("combobox", { name: "Date filter field" }), {
		target: { value: "completed" },
	});
	fireEvent.input(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });

	return mock;
}

describe("date-range filter (server-side, PROJ-212)", () => {
	it("sends completedAfter when field=Completed and a From date is set", async () => {
		const mock = await setupCompletedFromDateFilter();

		await waitFor(() => expect(lastIssuesUrl(mock)).toMatch(/completedAfter=\d+/));
		expect(lastIssuesUrl(mock)).not.toContain("updatedAfter=");
	});

	it("sends updatedBefore when field=Last edited and a To date is set", async () => {
		const mock = setupDateFetch();
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		fireEvent.change(screen.getByRole("combobox", { name: "Date filter field" }), {
			target: { value: "updated" },
		});
		fireEvent.input(screen.getByLabelText("To date"), { target: { value: "2026-03-01" } });

		await waitFor(() => expect(lastIssuesUrl(mock)).toMatch(/updatedBefore=\d+/));
		expect(lastIssuesUrl(mock)).not.toContain("completedBefore=");
	});

	it("sends no date params while the field is 'No date filter' even with dates entered", async () => {
		// Pick a field, set a date, then switch the field back off.
		const mock = await setupCompletedFromDateFilter();
		await waitFor(() => expect(lastIssuesUrl(mock)).toContain("completedAfter="));

		fireEvent.change(screen.getByRole("combobox", { name: "Date filter field" }), {
			target: { value: "" },
		});

		await waitFor(() => {
			const url = lastIssuesUrl(mock);
			expect(url).not.toContain("completedAfter=");
			expect(url).not.toContain("updatedAfter=");
		});
	});

	it("syncs the date filter to the URL and reads it back on mount", async () => {
		setupDateFetch();
		render(<IssueList />);
		await waitForLoaded();
		openFiltersPopover();

		fireEvent.change(screen.getByRole("combobox", { name: "Date filter field" }), {
			target: { value: "completed" },
		});
		fireEvent.input(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });

		await waitFor(() => {
			const params = new URLSearchParams(window.location.search);
			expect(params.get("dateField")).toBe("completed");
			expect(params.get("dateFrom")).toBe("2026-01-01");
		});

		// Remount from the synced URL — the field + From date are restored and
		// the very first list request already carries completedAfter.
		cleanup();
		const mock2 = setupDateFetch();
		render(<IssueList />);
		await waitForLoaded();

		await waitFor(() => expect(lastIssuesUrl(mock2)).toMatch(/completedAfter=\d+/));
	});
});
