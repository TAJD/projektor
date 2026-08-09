import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedViewFilters } from "../saved-views";
import SavedViewsControl from "./SavedViewsControl";
import { useSavedViews } from "./useSavedViews";

afterEach(cleanup);

const EMPTY_FILTERS: SavedViewFilters = {
	statuses: [],
	priorities: [],
	project: "PROJ",
	type: "",
	epicId: "",
	sprintId: "",
	hideEpics: false,
	dateField: "",
	dateFrom: "",
	dateTo: "",
};

function seedViews(names: string[]) {
	localStorage.setItem(
		"issue-views-PROJ",
		JSON.stringify(names.map((name) => ({ name, filters: EMPTY_FILTERS })))
	);
}

function Harness({ onApply }: { onApply: (f: SavedViewFilters) => void }) {
	const saved = useSavedViews("PROJ", EMPTY_FILTERS, onApply);
	return <SavedViewsControl saved={saved} />;
}

beforeEach(() => localStorage.clear());

// PROJ-565: SavedViewsControl's views menu is now a plain Select instance instead of a
// hand-rolled trigger/menu, so this exercises the migration end to end rather than the
// pieces Select.test.tsx already covers in isolation.
describe("SavedViewsControl — views menu on Select (PROJ-565)", () => {
	it("renders nothing when there are no saved views", () => {
		render(<Harness onApply={() => {}} />);
		expect(screen.queryByRole("combobox", { name: "Saved views" })).toBeNull();
	});

	it("shows the placeholder label until a view is applied", async () => {
		seedViews(["Sprint board"]);
		render(<Harness onApply={() => {}} />);
		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: "Saved views" }).textContent).toContain("Views")
		);
	});

	it("applies a view on selection and updates the trigger label", async () => {
		seedViews(["Sprint board", "My bugs"]);
		const onApply = vi.fn();
		render(<Harness onApply={onApply} />);

		await waitFor(() => screen.getByRole("combobox", { name: "Saved views" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Saved views" }));
		fireEvent.click(screen.getByRole("option", { name: /^My bugs/ }));

		expect(onApply).toHaveBeenCalledWith(EMPTY_FILTERS);
		expect(screen.getByRole("combobox", { name: "Saved views" }).textContent).toContain("My bugs");
	});

	it("deletes a view via its trailing action without applying it", async () => {
		seedViews(["Sprint board", "My bugs"]);
		const onApply = vi.fn();
		render(<Harness onApply={onApply} />);

		await waitFor(() => screen.getByRole("combobox", { name: "Saved views" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Saved views" }));
		fireEvent.click(screen.getByRole("option", { name: /^My bugs/ }));
		onApply.mockClear();
		fireEvent.click(screen.getByRole("combobox", { name: "Saved views" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete view Sprint board" }));

		expect(onApply).not.toHaveBeenCalled();
		expect(screen.queryByRole("option", { name: /^Sprint board/ })).toBeNull();
		expect(JSON.parse(localStorage.getItem("issue-views-PROJ") ?? "[]")).toHaveLength(1);
	});
});
