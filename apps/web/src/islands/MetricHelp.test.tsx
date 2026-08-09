import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeMetricHelpPosition, MetricHelp } from "./MetricHelp";
import { METRIC_DEFINITIONS, type MetricId } from "./metric-definitions";

/** jsdom has no layout: every rect is 0×0 unless stubbed. */
function rectAt(top: number, left = 10, height = 24, width = 100): DOMRect {
	return {
		top,
		bottom: top + height,
		left,
		right: left + width,
		width,
		height,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

const FIRST_METRIC_ID = Object.keys(METRIC_DEFINITIONS)[0] as MetricId;
const FIRST_METRIC_LABEL = METRIC_DEFINITIONS[FIRST_METRIC_ID].label;

describe("MetricHelp", () => {
	it("shows the trigger but not the definition until clicked", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		expect(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("toggles the definition popover open and closed on click", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		const trigger = screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` });

		fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: `${FIRST_METRIC_LABEL} definition` })).toBeTruthy();

		fireEvent.click(trigger);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on Escape", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on an outside click", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// PROJ-588: a plain CSS `absolute; left: 0` popover overflows the viewport's right
	// edge when the trigger sits near it on a narrow phone. `fixed` + a rect-derived,
	// viewport-clamped left escapes that — same fix as GlossaryHelp.tsx (PROJ-419).
	//
	// jsdom's getBoundingClientRect is always 0×0, so a wrapper's inline `left` (as the
	// old version of this test used) never reaches the component — it'd pass identically
	// with the clamp deleted. Stub the trigger's own rect instead, as FiltersPopover's
	// suite does for computeFiltersPopoverPosition.
	describe("computeMetricHelpPosition (PROJ-588)", () => {
		const originalHeight = window.innerHeight;
		const originalWidth = window.innerWidth;
		afterEach(() => {
			window.innerHeight = originalHeight;
			window.innerWidth = originalWidth;
		});

		it("clamps left so the panel's 16rem width stays within a narrow viewport", () => {
			window.innerWidth = 300;
			const pos = computeMetricHelpPosition(rectAt(50, 280, 24, 40));
			expect(pos.left).toBeLessThanOrEqual(300 - 256 - 8);
			expect(pos.left).toBeGreaterThanOrEqual(8);
		});

		it("flips above the trigger when there's too little room below but more above", () => {
			window.innerHeight = 500;
			// Trigger near the bottom: 500 - 480 - 4 - 8 = 8px below (< the 140px estimate).
			const pos = computeMetricHelpPosition(rectAt(460, 10, 20));
			expect(pos.top).toBeLessThan(460);
		});

		it("stays below the trigger when there's ample room", () => {
			window.innerHeight = 2000;
			const pos = computeMetricHelpPosition(rectAt(100, 10, 20));
			expect(pos.top).toBe(124);
		});
	});

	it("stubs the trigger's rect so the popover renders with fixed positioning near the clamped edge", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		const trigger = screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` });
		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rectAt(50, window.innerWidth - 20));

		fireEvent.click(trigger);
		const dialog = screen.getByRole("dialog");
		expect(dialog.style.position).toBe("fixed");
		expect(parseFloat(dialog.style.left)).toBeLessThanOrEqual(window.innerWidth - 256 - 8 + 1);
	});

	it("closes when an ancestor scrolls, rather than leaving a stale-positioned popover", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.scroll(window);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stays open on a height-only resize, but closes when the width changes (CD-294)", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));

		window.innerHeight = window.innerHeight - 300;
		fireEvent.resize(window);
		expect(screen.queryByRole("dialog")).toBeTruthy();

		window.innerWidth = window.innerWidth - 100;
		fireEvent.resize(window);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("portals the popover onto document.body and doesn't self-close on a click inside it", () => {
		render(<MetricHelp id={FIRST_METRIC_ID} />);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));
		const dialog = screen.getByRole("dialog");

		expect(dialog.parentElement).toBe(document.body);

		fireEvent.mouseDown(dialog);
		expect(screen.queryByRole("dialog")).toBeTruthy();
	});
});
