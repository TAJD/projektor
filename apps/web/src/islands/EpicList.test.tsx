// EpicList island — mock-fetch tests.
//
// EpicList reads ?projectId= from the URL, fetches task-types (to get the epic
// type ID) and issues (filtered client-side by type_key === "epic") via apiFetch.
// Without a projectId, fetchEpics returns early after setting loading=false.
// The pattern: set the URL, override the stub, await findBy*.
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EpicList from "./EpicList";

interface Issue {
	id: string;
	number: number;
	title: string;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	parent_id: string | null;
	project_key: string | null;
	project_name: string | null;
	type_key: string | null;
	type_name: string | null;
	status_id: string;
	status_key: string;
	status_name: string;
	status_category: string;
	sprint_id: string | null;
	updated_at: number;
	created_at: number;
}

const EPIC_ISSUE: Issue = {
	id: "e1",
	number: 10,
	title: "Big Epic",
	priority: "high",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Projektor",
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

// Fixtures for priority sort tests — created_at descending so the API returns them
// in LOW → MEDIUM → URGENT order (newest last); clicking Priority sorts differently.
const URGENT_EPIC: Issue = {
	...EPIC_ISSUE,
	id: "e-urgent",
	number: 11,
	title: "Urgent Epic",
	priority: "urgent",
	created_at: 3000,
};
const MEDIUM_EPIC: Issue = {
	...EPIC_ISSUE,
	id: "e-medium",
	number: 12,
	title: "Medium Epic",
	priority: "medium",
	created_at: 2000,
};
const LOW_EPIC: Issue = {
	...EPIC_ISSUE,
	id: "e-low",
	number: 13,
	title: "Low Epic",
	priority: "low",
	created_at: 1000,
};

function mockFetchEpics(issues: Issue[] = [EPIC_ISSUE]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/api/task-types")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve([{ id: "tt1", key: "epic", name: "Epic" }]),
				});
			}
			if (u.includes("/api/projects")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/api/issues")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		})
	);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

afterEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

describe("EpicList", () => {
	it("renders loading state while a fetch is pending", () => {
		// With a projectId in the URL and a never-resolving fetch, epicTypeId is
		// never set so fetchEpics returns early without clearing loading.
		history.replaceState(null, "", "?projectId=p1");
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<EpicList />);
		expect(screen.getByText(/Loading/i)).toBeTruthy();
	});

	it("shows empty state when there is no projectId in the URL", async () => {
		mockFetchEpics([]);
		render(<EpicList />);
		// No projectId → fetchEpics sets loading=false and returns early → empty state
		expect(await screen.findByText(/No epics found/i)).toBeTruthy();
	});

	it("ignores a stale localStorage project id not present in the project list", async () => {
		// No projectId in the URL; localStorage points at a project that no longer exists.
		localStorage.setItem("projektor-last-project-id", "stale-deleted-project");
		const calledUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				calledUrls.push(u);
				if (u.includes("/api/task-types")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([{ id: "tt1", key: "epic", name: "Epic" }]),
					});
				}
				if (u.includes("/api/projects")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([{ id: "p1", key: "PROJ", name: "Projektor" }]),
					});
				}
				if (u.includes("/api/issues")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [EPIC_ISSUE] }) });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
			})
		);

		render(<EpicList />);

		// Sensible default rendered: falls back to the first project and loads its epics.
		expect(await screen.findByText("Big Epic")).toBeTruthy();

		// The stale id never reached an API call.
		expect(calledUrls.some((u) => u.includes("stale-deleted-project"))).toBe(false);
		expect(calledUrls.some((u) => u.includes("/api/issues") && u.includes("project=p1"))).toBe(
			true
		);
		expect(localStorage.getItem("projektor-last-project-id")).toBe("p1");
	});

	it("renders epic rows after fetch resolves", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchEpics([EPIC_ISSUE]);
		render(<EpicList />);
		expect(await screen.findByText("Big Epic")).toBeTruthy();
		expect(screen.getByText("High")).toBeTruthy();
	});

	it("shows '+ New Epic' button when the epic task type is available", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchEpics([EPIC_ISSUE]);
		render(<EpicList />);
		await screen.findByText("Big Epic");
		expect(screen.getByRole("button", { name: /New Epic/i })).toBeTruthy();
	});

	it("shows an error message when the issues fetch fails", async () => {
		history.replaceState(null, "", "?projectId=p1");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				const u = String(url);
				if (u.includes("/api/task-types")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([{ id: "tt1", key: "epic", name: "Epic" }]),
					});
				}
				if (u.includes("/api/issues")) {
					return Promise.resolve({ ok: false, status: 500 });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			})
		);
		render(<EpicList />);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	// ─── Priority sort ──────────────────────────────────────────────────────────

	it("sorts epics by priority ascending (urgent first) when the Priority header is clicked", async () => {
		history.replaceState(null, "", "?projectId=p1");
		// API returns in created_at desc order: URGENT(3000) → MEDIUM(2000) → LOW(1000)
		mockFetchEpics([URGENT_EPIC, MEDIUM_EPIC, LOW_EPIC]);
		render(<EpicList />);

		// Wait for render
		await screen.findByText("Urgent Epic");

		// Click the Priority column header to sort ascending
		fireEvent.click(screen.getByRole("columnheader", { name: /Priority/i }));

		const dataRows = screen.getAllByRole("row").slice(1); // drop header row
		expect(dataRows[0].textContent).toContain("Urgent Epic");
		expect(dataRows[1].textContent).toContain("Medium Epic");
		expect(dataRows[2].textContent).toContain("Low Epic");
	});

	it("reverses to priority descending (low first) when the Priority header is clicked twice", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchEpics([URGENT_EPIC, MEDIUM_EPIC, LOW_EPIC]);
		render(<EpicList />);

		await screen.findByText("Urgent Epic");

		const header = screen.getByRole("columnheader", { name: /Priority/i });
		fireEvent.click(header); // asc
		fireEvent.click(header); // desc

		const dataRows = screen.getAllByRole("row").slice(1);
		expect(dataRows[0].textContent).toContain("Low Epic");
		expect(dataRows[1].textContent).toContain("Medium Epic");
		expect(dataRows[2].textContent).toContain("Urgent Epic");
	});

	it("shows a sort direction indicator on the Priority header after clicking", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchEpics([URGENT_EPIC, MEDIUM_EPIC, LOW_EPIC]);
		render(<EpicList />);

		await screen.findByText("Urgent Epic");

		const header = screen.getByRole("columnheader", { name: /Priority/i });

		// Before clicking: no indicator
		expect(header.textContent).not.toContain("↑");
		expect(header.textContent).not.toContain("↓");

		// After first click: ascending indicator
		fireEvent.click(header);
		expect(header.textContent).toContain("↑");

		// After second click: descending indicator
		fireEvent.click(header);
		expect(header.textContent).toContain("↓");
	});
});
