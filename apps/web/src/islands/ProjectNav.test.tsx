// ProjectNav island — canonical mock-fetch test. ProjectNav reads the URL on mount and,
// if a project id/key is in the query, fetches it — set the URL with history.pushState
// first, stub fetch with vi.stubGlobal per case, then await findByText for the async update.
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectNav from "./ProjectNav";

const PROJECT = { id: "p1", key: "PROJ", name: "Projektor", slug: "projektor" };

function mockFetchProject(project: typeof PROJECT | null) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(project) })
	);
}

// Priority+ overflow: jsdom never computes real layout, so ProjectNav's width/tab
// measurements (nav.clientWidth, each tab span's offsetWidth) are 0 unless stubbed here.
// stubNavMeasurements fixes the nav's clientWidth and every tab's offsetWidth so the
// overflow math in ProjectNav is exercised deterministically.
let offsetWidthDescriptor: PropertyDescriptor | undefined;
let clientWidthDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	offsetWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
	clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
});

afterEach(() => {
	if (offsetWidthDescriptor)
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
	if (clientWidthDescriptor)
		Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
});

function stubNavMeasurements(containerWidth: number, tabWidth: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute("aria-label") === "Project sections" ? containerWidth : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.querySelector?.("a")?.textContent?.trim() ? tabWidth : 0;
		},
	});
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
	it("applies compact-mobile classes to the header and tab row", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

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

describe("ProjectNav — Priority+ overflow menu", () => {
	it("renders every tab directly with no More trigger when they all fit", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		stubNavMeasurements(2000, 80);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		for (const label of ["Overview", "Issues", "Wiki", "Sprints", "Epics", "Metrics", "Feedback"]) {
			expect(screen.getByRole("link", { name: label })).toBeTruthy();
		}
		expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
	});

	it("moves trailing tabs into the More menu once the nav is too narrow to fit them all", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		stubNavMeasurements(340, 90);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Issues" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Wiki" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Feedback" })).toBeNull();

		const more = screen.getByRole("button", { name: /more/i });
		expect(more.getAttribute("aria-haspopup")).toBe("menu");
		expect(more.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("highlights the More trigger when the active tab has overflowed into the menu", async () => {
		window.history.pushState({}, "", "/feedback?id=p1");
		mockFetchProject(PROJECT);
		stubNavMeasurements(340, 90);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		const more = screen.getByRole("button", { name: /more/i });
		expect(more.getAttribute("aria-current")).toBe("true");

		fireEvent.click(more);
		const feedbackItem = screen.getByRole("menuitem", { name: "Feedback" });
		expect(feedbackItem.getAttribute("aria-current")).toBe("page");
	});

	it("opens the menu with hidden tabs' correct ?projectId hrefs, and closes it on selection", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		stubNavMeasurements(340, 90);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		fireEvent.click(screen.getByRole("button", { name: /more/i }));
		const menu = screen.getByRole("menu", { name: "More project sections" });
		expect(menu).toBeTruthy();

		const wikiItem = screen.getByRole("menuitem", { name: "Wiki" });
		expect(wikiItem.getAttribute("href")).toBe("/wiki?projectId=p1");
		const feedbackItem = screen.getByRole("menuitem", { name: "Feedback" });
		expect(feedbackItem.getAttribute("href")).toBe("/feedback?projectId=p1");

		fireEvent.click(wikiItem);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("closes the menu on Escape and on an outside click", async () => {
		window.history.pushState({}, "", "/issues?id=p1");
		mockFetchProject(PROJECT);
		stubNavMeasurements(340, 90);
		render(<ProjectNav />);
		await screen.findByText("Projektor");

		fireEvent.click(screen.getByRole("button", { name: /more/i }));
		expect(screen.getByRole("menu")).toBeTruthy();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /more/i }));
		expect(screen.getByRole("menu")).toBeTruthy();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
	});
});
