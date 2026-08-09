import { afterEach, describe, expect, it } from "vitest";
import { computeFiltersPopoverPosition } from "./FiltersPopover";

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

// PROJ-588: opened low on a phone, this fixed-position panel had no viewport clamping —
// the date-range fields and "Clear all" could fall below the viewport with nothing to
// scroll to reach them.
describe("computeFiltersPopoverPosition (PROJ-588)", () => {
	const originalHeight = window.innerHeight;
	const originalWidth = window.innerWidth;
	afterEach(() => {
		window.innerHeight = originalHeight;
		window.innerWidth = originalWidth;
	});

	it("opens below the trigger and clamps maxHeight to the space available", () => {
		window.innerHeight = 500;
		// 500 - 224 - 4 - 8 = 264px below.
		expect(computeFiltersPopoverPosition(rectAt(200))).toEqual({
			top: 228,
			left: 10,
			maxHeight: 264,
		});
	});

	it("never exceeds the panel's 420px ceiling when there is ample room", () => {
		window.innerHeight = 2000;
		expect(computeFiltersPopoverPosition(rectAt(100)).maxHeight).toBe(420);
	});

	it("flips above the trigger when there's too little room below but more above", () => {
		window.innerHeight = 500;
		// Trigger near the bottom: 500 - 480 - 4 - 8 = 8px below (< the 160px floor).
		// Above: 460 - 4 - 8 = 448px, clamped to the 420px ceiling.
		const pos = computeFiltersPopoverPosition(rectAt(460, 10, 20));
		expect(pos.top).toBeLessThan(460);
		expect(pos.maxHeight).toBe(420);
	});

	it("clamps left so the panel's 16rem width stays within a narrow viewport", () => {
		window.innerWidth = 300;
		// Trigger near the right edge: left=280 would push the 256px-wide panel off-screen.
		const pos = computeFiltersPopoverPosition(rectAt(50, 280, 24, 40));
		expect(pos.left).toBeLessThanOrEqual(300 - 256 - 8);
		expect(pos.left).toBeGreaterThanOrEqual(8);
	});
});
