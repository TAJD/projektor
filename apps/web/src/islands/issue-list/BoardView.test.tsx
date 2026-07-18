// BoardView — mobile viewport tests (PROJ-417).
//
// BoardView disables HTML5 drag-and-drop below 640px (native DnD doesn't work
// on touch devices) by checking `window.innerWidth` directly in its drag
// handlers. This exercises that branch with the shared viewport helper,
// rather than relying on the `max-sm:` CSS classes alone.
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_WIDTH, setViewportWidth } from "../../test/viewport";
import type { Issue, TaskStatus } from "../board-utils";
import BoardView from "./BoardView";

const TODO_ISSUE: Issue = {
	id: "i1",
	number: 1,
	title: "Move me",
	priority: "high",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Projektor",
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

const STATUSES: TaskStatus[] = [
	{ id: "st-todo", key: "todo", name: "Todo", category: "todo", color: null },
	{
		id: "st-in-progress",
		key: "in_progress",
		name: "In Progress",
		category: "in_progress",
		color: null,
	},
];

function fakeDataTransfer() {
	const store = new Map<string, string>();
	return {
		setData: (type: string, val: string) => store.set(type, val),
		getData: (type: string) => store.get(type) ?? "",
	};
}

describe("BoardView — mobile viewport", () => {
	it("blocks drag-and-drop status changes below 640px", () => {
		const changeStatus = vi.fn();
		setViewportWidth(MOBILE_WIDTH);
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);

		const card = screen.getByText("Move me").closest("a") as HTMLElement;
		const dataTransfer = fakeDataTransfer();
		fireEvent.dragStart(card, { dataTransfer });

		const inProgressColumn = screen.getByRole("region", { name: "In Progress column" });
		fireEvent.drop(inProgressColumn, { dataTransfer });

		expect(changeStatus).not.toHaveBeenCalled();
	});

	it("allows drag-and-drop status changes at desktop widths", () => {
		const changeStatus = vi.fn();
		setViewportWidth(1024);
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);

		const card = screen.getByText("Move me").closest("a") as HTMLElement;
		const dataTransfer = fakeDataTransfer();
		fireEvent.dragStart(card, { dataTransfer });

		const inProgressColumn = screen.getByRole("region", { name: "In Progress column" });
		fireEvent.drop(inProgressColumn, { dataTransfer });

		expect(changeStatus).toHaveBeenCalledWith("i1", "st-in-progress");
	});

	it("blocks the drop itself below 640px, even with data already set", () => {
		// onDragStart already blocks setData below 640px, so the desktop/mobile
		// tests above can't tell whether the drop handler's own width guard does
		// anything. Seed dataTransfer at desktop width, then drop at mobile width
		// to isolate that guard.
		const changeStatus = vi.fn();
		setViewportWidth(1024);
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);

		const card = screen.getByText("Move me").closest("a") as HTMLElement;
		const dataTransfer = fakeDataTransfer();
		fireEvent.dragStart(card, { dataTransfer });

		setViewportWidth(MOBILE_WIDTH);
		const inProgressColumn = screen.getByRole("region", { name: "In Progress column" });
		fireEvent.drop(inProgressColumn, { dataTransfer });

		expect(changeStatus).not.toHaveBeenCalled();
	});
});

describe("BoardView — mobile status menu (PROJ-416)", () => {
	it("renders a tap-to-open status menu on each card", () => {
		const changeStatus = vi.fn();
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);
		expect(screen.getByRole("combobox", { name: "Change status for issue PROJ-1" })).toBeTruthy();
	});

	it("changes status when a different option is chosen from the menu", () => {
		const changeStatus = vi.fn();
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);

		fireEvent.click(screen.getByRole("combobox", { name: "Change status for issue PROJ-1" }));
		fireEvent.click(screen.getByRole("option", { name: "In Progress" }));

		expect(changeStatus).toHaveBeenCalledWith("i1", "st-in-progress");
	});

	it("renders the status menu outside the card's link, not nested inside it", () => {
		// The whole card body is a draggable <a> (desktop DnD target); nesting an
		// interactive Select inside it would be invalid HTML (no interactive
		// descendants in an <a>) and would risk taps on the menu also triggering
		// navigation. The status menu must be a sibling of the <a>, not a child.
		const changeStatus = vi.fn();
		render(<BoardView issues={[TODO_ISSUE]} statuses={STATUSES} changeStatus={changeStatus} />);

		const link = screen.getByText("Move me").closest("a") as HTMLElement;
		const trigger = screen.getByRole("combobox", { name: "Change status for issue PROJ-1" });

		expect(link.contains(trigger)).toBe(false);
	});
});
