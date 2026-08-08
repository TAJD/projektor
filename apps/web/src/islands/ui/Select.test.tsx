// Select island — canonical interaction test.
//
// Select renders no network, so this is the simplest pattern: render with props,
// drive it with fireEvent, assert on rendered text and the onChange spy.
// Cleanup + global restore happen in src/test/setup.ts.
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import Select, { computeMenuPosition, type SelectOption } from "./Select";

const OPTIONS: SelectOption[] = [
	{ value: "open", label: "Open" },
	{ value: "done", label: "Done" },
];

/** jsdom has no layout: every rect is 0×0 unless stubbed. */
function stubRect(el: Element, top: number, height = 24) {
	(el as HTMLElement).getBoundingClientRect = () =>
		({
			top,
			bottom: top + height,
			left: 10,
			right: 110,
			width: 100,
			height,
			x: 10,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
}

function rectAt(top: number, height = 24): DOMRect {
	return {
		top,
		bottom: top + height,
		left: 10,
		right: 110,
		width: 100,
		height,
		x: 10,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("Select", () => {
	it("renders the placeholder (raw value) when no option matches", () => {
		render(<Select value="" options={OPTIONS} onChange={() => {}} ariaLabel="Status" />);
		// No option has value "", so the trigger falls back to the raw value ("").
		const button = screen.getByRole("combobox", { name: "Status" });
		expect(button.textContent).toContain("▾");
	});

	it("renders the selected option's label when value matches", () => {
		render(<Select value="done" options={OPTIONS} onChange={() => {}} ariaLabel="Status" />);
		expect(screen.getByText("Done")).toBeTruthy();
	});

	it("calls onChange with the option value when an option is clicked", () => {
		const onChange = vi.fn();
		render(<Select value="open" options={OPTIONS} onChange={onChange} ariaLabel="Status" />);
		// Open the menu, then click the "Done" option.
		fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
		fireEvent.click(screen.getByRole("option", { name: "Done" }));
		expect(onChange).toHaveBeenCalledWith("done");
	});

	it("renders a disabled trigger when disabled", () => {
		render(
			<Select value="open" options={OPTIONS} onChange={() => {}} ariaLabel="Status" disabled />
		);
		const button = screen.getByRole("combobox", { name: "Status" });
		// The native `disabled` attribute is what blocks pointer interaction in the
		// browser; keyboard handling also early-returns on `disabled`.
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});

// CD-294: the real iOS failure mode. Safari fires `resize` when the on-screen
// keyboard opens and when its own chrome collapses/expands during a scroll, and
// the old handler closed the menu on ANY resize or ancestor scroll — so a
// dropdown vanished the moment it was tapped. These encode "reposition, don't
// close" while keeping genuine dismissals intact.
describe("Select — menu survives viewport churn (CD-294)", () => {
	const originalHeight = window.innerHeight;
	const originalWidth = window.innerWidth;

	afterEach(() => {
		window.innerHeight = originalHeight;
		window.innerWidth = originalWidth;
	});

	function openAt(top: number) {
		const view = render(
			<Select value="open" options={OPTIONS} onChange={() => {}} ariaLabel="Status" />
		);
		const button = screen.getByRole("combobox", { name: "Status" });
		stubRect(button, top);
		fireEvent.click(button);
		return { ...view, button };
	}

	it("repositions (not closes) when an ancestor scrolls", () => {
		const { container, button } = openAt(100);
		const menu = screen.getByRole("listbox", { name: "Status" });
		expect(menu.style.top).toBe("128px");

		stubRect(button, 300);
		// `container` wraps the Select root, so this is an *ancestor* scroll.
		fireEvent.scroll(container);

		const after = screen.getByRole("listbox", { name: "Status" });
		expect(after).toBeTruthy();
		expect(after.style.top).toBe("328px");
	});

	it("repositions (not closes) on a height-only resize, flipping above when below runs out", () => {
		openAt(300);
		expect(screen.getByRole("listbox", { name: "Status" }).style.top).toBe("328px");

		// Keyboard opens: height shrinks, width is untouched.
		window.innerHeight = 400;
		fireEvent.resize(window);

		const after = screen.getByRole("listbox", { name: "Status" });
		expect(after).toBeTruthy();
		// Only 64px below the trigger, so it flips above it: 300 - 4 - 256.
		expect(after.style.top).toBe("40px");
		expect(after.style.maxHeight).toBe("256px");
	});

	it("closes on a width-changing resize (orientation change)", () => {
		openAt(100);
		expect(screen.queryByRole("listbox", { name: "Status" })).toBeTruthy();

		window.innerWidth = 375;
		fireEvent.resize(window);

		expect(screen.queryByRole("listbox", { name: "Status" })).toBeNull();
	});

	// jsdom implements no PointerEvent, and `fireEvent.pointerDown` silently
	// dispatches nothing as a result — hand-roll a bubbling Event instead.
	function pointerDown(target: Element) {
		fireEvent(target, new Event("pointerdown", { bubbles: true }));
	}

	it("closes on an outside pointerdown", () => {
		openAt(100);
		expect(screen.queryByRole("listbox", { name: "Status" })).toBeTruthy();

		pointerDown(document.body);

		expect(screen.queryByRole("listbox", { name: "Status" })).toBeNull();
	});

	it("stays open when the pointerdown lands inside the menu itself", () => {
		openAt(100);
		pointerDown(screen.getByRole("option", { name: "Done" }));
		expect(screen.queryByRole("listbox", { name: "Status" })).toBeTruthy();
	});
});

describe("computeMenuPosition (CD-294)", () => {
	const originalHeight = window.innerHeight;
	afterEach(() => {
		window.innerHeight = originalHeight;
	});

	it("opens below and clamps maxHeight to the space available", () => {
		window.innerHeight = 400;
		// 400 - 224 - 4 - 8 = 164px below.
		expect(computeMenuPosition(rectAt(200))).toEqual({
			top: 228,
			left: 10,
			width: 100,
			maxHeight: 164,
		});
	});

	it("never exceeds the menu's 16rem CSS ceiling when there is ample room", () => {
		window.innerHeight = 2000;
		expect(computeMenuPosition(rectAt(100)).maxHeight).toBe(256);
	});

	it("prefers the visual viewport height over innerHeight when available", () => {
		window.innerHeight = 800;
		Object.defineProperty(window, "visualViewport", {
			value: { height: 300 },
			configurable: true,
		});
		try {
			// 300 - 224 - 12 = 64px below (< the 80px floor), 188px above → flips.
			expect(computeMenuPosition(rectAt(200)).top).toBeLessThan(200);
		} finally {
			Object.defineProperty(window, "visualViewport", {
				value: undefined,
				configurable: true,
			});
		}
	});
});
