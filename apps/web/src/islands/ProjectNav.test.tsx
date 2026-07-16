// ProjectNav island — canonical mock-fetch test.
//
// ProjectNav reads the URL (window.location) on mount and, if there's a project
// id/key in the query, fetches it. The pattern here:
//   • set the URL with history.pushState before render (jsdom updates location);
//   • override the default fetch stub from setup.ts with vi.stubGlobal to return
//     the project payload this case needs;
//   • await findByText for the async state update after fetch resolves.
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import ProjectNav from "./ProjectNav";

const PROJECT = { id: "p1", key: "PROJ", name: "Projektor", slug: "projektor" };

function mockFetchProject(project: typeof PROJECT | null) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(project) })
	);
}

describe("ProjectNav", () => {
	it("renders nothing when there is no project in the URL", () => {
		window.history.pushState({}, "", "/issues");
		const { container } = render(<ProjectNav />);
		// No id/project param → no fetch, component returns null.
		expect(container.innerHTML).toBe("");
	});

	it("renders the project name and key badge once the fetch resolves", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		expect(await screen.findByText("Projektor")).toBeTruthy();
		expect(screen.getByText("PROJ")).toBeTruthy();
	});

	it("marks the tab matching the current pathname as active", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");
		// pathname is /issues, so the Issues tab gets aria-current="page".
		const issuesTab = screen.getByRole("link", { name: "Issues" });
		expect(issuesTab.getAttribute("aria-current")).toBe("page");
		const wikiTab = screen.getByRole("link", { name: "Wiki" });
		expect(wikiTab.getAttribute("aria-current")).toBeNull();
	});

	it("sets the document title to '<pageLabel> — <project name>' once resolved", async () => {
		window.history.pushState({}, "", "/epics?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav pageLabel="Epics" />);
		await screen.findByText("Projektor");
		expect(document.title).toBe("Epics — Projektor");
	});

	it("leaves the document title untouched when no pageLabel is given", async () => {
		document.title = "unchanged";
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");
		expect(document.title).toBe("unchanged");
	});

	// jsdom doesn't compute layout, so this only proves the compacting classes are
	// present at render time — not that they actually shrink the nav in a real
	// viewport. See PROJ-346; real-viewport confirmation happens separately.
	it("applies compact-mobile and horizontal-scroll classes to the header and tab row", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		const nav = screen.getByRole("navigation", { name: "Project sections" });
		expect(nav.className).toContain("max-sm:overflow-x-auto");

		const issuesTab = screen.getByRole("link", { name: "Issues" });
		expect(issuesTab.className).toContain("max-sm:px-2.5");

		const heading = screen.getByText("Projektor");
		expect(heading.className).toContain("max-sm:text-[0.8125rem]");
	});

	// PROJ-376: pretty project URLs (/projects/view/<slug>).
	it("resolves the project from a /projects/view/<slug> path with no query param", async () => {
		window.history.pushState({}, "", "/projects/view/projektor");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		expect(await screen.findByText("Projektor")).toBeTruthy();
	});

	it("builds the Overview tab link and header link from the project's slug", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");
		const overviewTab = screen.getByRole("link", { name: "Overview" });
		expect(overviewTab.getAttribute("href")).toBe("/projects/view/projektor");
		const headerLink = screen.getByText("Projektor").closest("a");
		expect(headerLink?.getAttribute("href")).toBe("/projects/view/projektor");
	});

	it("marks Overview active when on its slug path, even without a matching plain-path tab", async () => {
		window.history.pushState({}, "", "/projects/view/projektor");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");
		const overviewTab = screen.getByRole("link", { name: "Overview" });
		expect(overviewTab.getAttribute("aria-current")).toBe("page");
	});

	it("renders a Feedback tab linking to /feedback?projectId", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				if (String(url).includes("/api/projects/")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ id: "p1", key: "PROJ", name: "Proj", slug: null }),
					});
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			})
		);
		window.history.pushState({}, "", "/metrics?projectId=p1");
		render(<ProjectNav workspaceSlug="my-ws" />);
		const link = (await screen.findByText("Feedback")) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/feedback?projectId=p1");
	});
});
