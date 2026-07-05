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

const PROJECT = { id: "p1", key: "PROJ", name: "Projektor" };

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
});
