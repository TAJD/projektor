// ProjectLanding island — mock-fetch tests.
//
// ProjectLanding reads ?id= from the URL, then fetches the project, its issues,
// and its wiki pages in parallel via raw fetch + buildHeaders.
// loading starts true, so the loading state appears immediately.
// The pattern: set the URL, override the stub, await findBy*.
import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectLanding from "./ProjectLanding";

const PROJECT = {
	id: "p1",
	name: "Projektor",
	key: "PROJ",
	description: "An issue tracker.",
	workspaceId: "w1",
	createdAt: 0,
	updatedAt: 0,
};

const ISSUE = {
	id: "i1",
	number: 1,
	title: "Fix the bug",
	project_key: "PROJ",
	status_name: "Todo",
	status_key: "todo",
	status_category: "todo",
	updated_at: 1000,
};

function mockFetchProject(
	issues: (typeof ISSUE)[] = [ISSUE],
	wiki: unknown[] = [],
	flowMetrics: unknown = { throughputOverTime: [], cfdOverTime: [] }
) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/api/issues")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
			}
			if (u.includes("/api/wiki")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(wiki) });
			}
			if (u.includes("/flow-metrics")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(flowMetrics) });
			}
			// project fetch
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECT) });
		})
	);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
});

afterEach(() => {
	history.replaceState(null, "", "/");
});

describe("ProjectLanding", () => {
	it("renders loading state initially (no projectId)", () => {
		render(<ProjectLanding />);
		expect(screen.getByText(/Loading/i)).toBeTruthy();
	});

	it("renders project name and description after fetch", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject();
		render(<ProjectLanding />);
		// Use heading role to target the <h1> specifically — "Projektor" also appears in the breadcrumb nav.
		expect(await screen.findByRole("heading", { name: "Projektor" })).toBeTruthy();
		expect(screen.getByText("An issue tracker.")).toBeTruthy();
	});

	it("renders recent issues list after fetch", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([ISSUE]);
		render(<ProjectLanding />);
		expect(await screen.findByText("Fix the bug")).toBeTruthy();
	});

	it("shows 'No issues yet.' when the project has no issues", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([]);
		render(<ProjectLanding />);
		await screen.findByRole("heading", { name: "Projektor" });
		expect(screen.getByText(/No issues yet/i)).toBeTruthy();
	});

	it("shows an error message when the project fetch fails", async () => {
		history.replaceState(null, "", "?id=p1");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
		render(<ProjectLanding />);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	it("shows an empty state for the flow charts on a project with no history", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([ISSUE], [], { throughputOverTime: [], cfdOverTime: [] });
		render(<ProjectLanding />);
		await screen.findByRole("heading", { name: "Projektor" });
		expect(await screen.findByText(/Flow \(last 6 weeks\)/i)).toBeTruthy();
		expect(screen.getAllByText(/No (completed issues|issues in this window)/i).length).toBe(2);
	});

	it("renders throughput and cumulative flow charts when the project has flow history", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([ISSUE], [], {
			throughputOverTime: [{ bucketStart: "2024-01-01", count: 3 }],
			cfdOverTime: [
				{ bucketStart: "2024-01-01", backlogTodo: 2, inProgress: 1, inReview: 0, done: 3 },
			],
		});
		render(<ProjectLanding />);
		await screen.findByRole("heading", { name: "Projektor" });
		expect(await screen.findByText(/Flow \(last 6 weeks\)/i)).toBeTruthy();
		expect(screen.getByText("Throughput")).toBeTruthy();
		expect(screen.getByText("Cumulative flow")).toBeTruthy();
	});
});
