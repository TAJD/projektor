// ProjectLanding island — mock-fetch tests.
//
// ProjectLanding reads ?id= from the URL, then fetches the project, its issues,
// and its wiki pages in parallel via raw fetch + buildHeaders.
// loading starts true, so the loading state appears immediately.
// The pattern: set the URL, override the stub, await findBy*.
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetProjectStoreForTests } from "../lib/project-context";
import ProjectLanding from "./ProjectLanding";

const PROJECT = {
	id: "p1",
	name: "Projektor",
	key: "PROJ",
	slug: "projektor",
	description: "An issue tracker.",
	archivedAt: null,
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

const WIKI_PAGE = {
	id: "w1",
	slug: "getting-started",
	title: "Getting Started",
	updated_at: 1000,
};

function mockFetchProject(
	issues: readonly (typeof ISSUE)[] = [ISSUE],
	wiki: readonly unknown[] = [],
	flowMetrics: unknown = { throughputOverTime: [], cfdOverTime: [] },
	project: unknown = PROJECT,
	projectsList: readonly unknown[] = [project]
) {
	const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
		const u = String(url);
		if (u.endsWith("/api/projects")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(projectsList) });
		}
		if (u.includes("/api/issues")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: issues }) });
		}
		if (u.includes("/api/wiki")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(wiki) });
		}
		if (u.includes("/flow-metrics")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(flowMetrics) });
		}
		if (opts?.method === "PATCH") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		}
		// project fetch
		return Promise.resolve({ ok: true, json: () => Promise.resolve(project) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	__resetProjectStoreForTests();
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

	it("clears loading and shows 'No project specified' when no id/slug/fallback resolves (PROJ-723)", async () => {
		mockFetchProject(undefined, undefined, undefined, undefined, []);
		render(<ProjectLanding />);
		expect(await screen.findByText(/No project specified/i)).toBeTruthy();
		expect(screen.queryByText(/Loading/i)).toBeNull();
	});

	it("falls back to the stored project id when no URL param or slug is present, matching ProjectNav (PROJ-723)", async () => {
		localStorage.setItem("projektor-last-project-id", "p1");
		mockFetchProject();
		render(<ProjectLanding />);
		expect(await screen.findByRole("heading", { name: "Projektor" })).toBeTruthy();
		localStorage.removeItem("projektor-last-project-id");
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

	it("recent-wiki links preserve projectId so the destination stays scoped (PROJ-352, PROJ-487)", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([ISSUE], [WIKI_PAGE]);
		render(<ProjectLanding />);
		const link = (await screen.findByText("Getting Started")).closest("a");
		expect(link?.getAttribute("href")).toBe("/wiki/getting-started?projectId=p1");
	});

	// PROJ-376: pretty project URLs (/projects/view/<slug>) resolve via the path,
	// not just ?id=.
	it("resolves the project from a /projects/view/<slug> path with no query param", async () => {
		history.replaceState(null, "", "/projects/view/projektor");
		mockFetchProject();
		render(<ProjectLanding />);
		expect(await screen.findByRole("heading", { name: "Projektor" })).toBeTruthy();
	});

	it("breadcrumb has no redundant 'Projektor /' prefix (PROJ-353)", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject();
		render(<ProjectLanding />);
		await screen.findByRole("heading", { name: "Projektor" });
		const nav = screen.getByRole("navigation");
		expect(nav.textContent?.trim()).toBe("Projects/Projektor");
	});
});

describe("ProjectLanding — archive/unarchive (PROJ-649)", () => {
	it("shows an Archive button and archives the project on click", async () => {
		history.replaceState(null, "", "?id=p1");
		const fetchMock = mockFetchProject([]);
		render(<ProjectLanding />);
		await screen.findByRole("heading", { name: "Projektor" });

		const archiveButton = screen.getByRole("button", { name: "Archive" });
		fireEvent.click(archiveButton);

		expect(await screen.findByRole("button", { name: "Unarchive" })).toBeTruthy();
		expect(screen.getByText("Archived")).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/projects/p1",
			expect.objectContaining({ method: "PATCH", body: JSON.stringify({ archived: true }) })
		);
	});

	it("shows Unarchive for an already-archived project", async () => {
		history.replaceState(null, "", "?id=p1");
		mockFetchProject([], [], undefined, { ...PROJECT, archivedAt: 1700000000 });
		render(<ProjectLanding />);
		expect(await screen.findByRole("button", { name: "Unarchive" })).toBeTruthy();
	});
});
