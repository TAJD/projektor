import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { MetricHelp } from "./MetricHelp";
import { METRIC_DEFINITIONS, type MetricId } from "./metric-definitions";

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
	it("clamps the popover's left position within the viewport", () => {
		render(
			<div style={{ position: "absolute", left: `${window.innerWidth - 20}px` }}>
				<MetricHelp id={FIRST_METRIC_ID} />
			</div>
		);
		fireEvent.click(screen.getByRole("button", { name: `About ${FIRST_METRIC_LABEL}` }));
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
