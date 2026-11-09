import { fireEvent, render, screen } from "@testing-library/preact";
import { createRef } from "preact";
import { describe, expect, it, vi } from "vitest";
import Toolbar from "./Toolbar";

// The popover and saved-views control have their own tests; stub them so this file
// exercises only the toolbar's own layout decisions.
vi.mock("./FiltersPopover", () => ({ default: () => <button type="button">Filters</button> }));
vi.mock("./SavedViewsControl", () => ({ default: () => null }));

type ToolbarProps = Parameters<typeof Toolbar>[0];

function renderToolbar(overrides: Partial<ToolbarProps> = {}) {
	const noop = () => {};
	const props = {
		searchQuery: "",
		setSearchQuery: noop,
		isSearchActive: false,
		searchInputRef: createRef<HTMLInputElement>(),
		derivedStatuses: [],
		filterStatuses: [],
		setFilterStatuses: noop,
		filterPriorities: [],
		setFilterPriorities: noop,
		filterDateField: "",
		setFilterDateField: noop,
		filterDateFrom: "",
		setFilterDateFrom: noop,
		filterDateTo: "",
		setFilterDateTo: noop,
		saved: {},
		sortBy: "created_at",
		setSortBy: noop,
		sortDir: "desc",
		setSortDir: noop,
		uniqueProjects: [{ key: "WEB", name: "Website" }],
		filterProject: "",
		setFilterProject: noop,
		setFilterSprintId: noop,
		sprints: [],
		filterSprintId: "",
		uniqueTypes: [["task", "Task"]],
		filterType: "",
		setFilterType: noop,
		epics: [],
		filterEpicId: "",
		setFilterEpicId: noop,
		hideEpics: false,
		setHideEpics: noop,
		...overrides,
	} as unknown as ToolbarProps;
	return render(<Toolbar {...props} />);
}

describe("Toolbar — single-choice pickers are hidden", () => {
	it("hides the project and type pickers when there is only one of each", () => {
		renderToolbar();
		expect(screen.queryByRole("combobox", { name: "Filter by project" })).toBeNull();
		expect(screen.queryByRole("combobox", { name: "Filter by type" })).toBeNull();
	});

	it("shows them when there is a real choice", () => {
		renderToolbar({
			uniqueProjects: [
				{ key: "WEB", name: "Website" },
				{ key: "API", name: "API" },
			],
			uniqueTypes: [
				["task", "Task"],
				["bug", "Bug"],
			],
		});
		expect(screen.getByRole("combobox", { name: "Filter by project" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Filter by type" })).toBeTruthy();
	});

	it("keeps a picker visible while its filter is set, so it can be cleared", () => {
		renderToolbar({ filterProject: "WEB", filterType: "task" });
		expect(screen.getByRole("combobox", { name: "Filter by project" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Filter by type" })).toBeTruthy();
	});
});

describe("Toolbar — secondary controls fold away on phones", () => {
	it("collapses sort/saved views behind a 'More options' toggle below sm", () => {
		renderToolbar();
		const more = screen.getByTestId("issue-toolbar-more");
		const toggle = screen.getByRole("button", { name: "More options" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(more.className).toContain("max-sm:hidden");
		// Desktop keeps the controls inline in the same flex row.
		expect(more.className).toContain("contents");

		fireEvent.click(toggle);
		expect(
			screen.getByRole("button", { name: "Fewer options" }).getAttribute("aria-expanded")
		).toBe("true");
		expect(more.className).toContain("max-sm:flex");
		expect(more.className).not.toContain("max-sm:hidden");
	});

	it("the toggle itself is phone-only", () => {
		renderToolbar();
		const wrapper = screen.getByRole("button", { name: "More options" }).parentElement;
		expect(wrapper?.className).toContain("hidden");
		expect(wrapper?.className).toContain("max-sm:contents");
	});
});
