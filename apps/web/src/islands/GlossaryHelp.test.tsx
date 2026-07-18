import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { GlossaryHelp } from "./GlossaryHelp";

describe("GlossaryHelp", () => {
	it("shows the trigger but not the definition until clicked", () => {
		render(<GlossaryHelp id="sprint" />);
		expect(screen.getByRole("button", { name: "About Sprint" })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("toggles the definition popover open and closed on click", () => {
		render(<GlossaryHelp id="sprint" />);
		const trigger = screen.getByRole("button", { name: "About Sprint" });

		fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: "Sprint definition" })).toBeTruthy();

		fireEvent.click(trigger);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on Escape", () => {
		render(<GlossaryHelp id="epic" />);
		fireEvent.click(screen.getByRole("button", { name: "About Epic" }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on an outside click", () => {
		render(<GlossaryHelp id="groups" />);
		fireEvent.click(screen.getByRole("button", { name: "About Groups" }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("positions the popover with position: fixed, not absolute (PROJ-419)", () => {
		// A plain CSS `absolute` popover gets clipped by any ancestor with
		// non-visible overflow (e.g. the sidebar's `overflow-y: auto`, which
		// forces overflow-x to `auto` too). `fixed` + a rect computed from the
		// trigger escapes that clipping — see Select.tsx's dropdown for the
		// same pattern.
		render(<GlossaryHelp id="tokens" />);
		fireEvent.click(screen.getByRole("button", { name: "About Tokens" }));
		const dialog = screen.getByRole("dialog");
		expect(dialog.style.position).toBe("fixed");
	});

	it("closes when an ancestor scrolls, rather than leaving a stale-positioned popover", () => {
		render(<GlossaryHelp id="tokens" />);
		fireEvent.click(screen.getByRole("button", { name: "About Tokens" }));
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.scroll(window);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("portals the popover onto document.body and doesn't self-close on a click inside it (PROJ-419)", () => {
		// Portalled to escape a transformed ancestor's containing-block trap for
		// `position: fixed` (the mobile off-canvas drawer applies a CSS
		// transform to the sidebar, which would otherwise reintroduce clipping).
		// A click landing on the popover's own content is not "outside" even
		// though it's no longer a DOM descendant of the trigger's <span>.
		render(<GlossaryHelp id="tokens" />);
		fireEvent.click(screen.getByRole("button", { name: "About Tokens" }));
		const dialog = screen.getByRole("dialog");

		expect(dialog.parentElement).toBe(document.body);

		fireEvent.mouseDown(dialog);
		expect(screen.queryByRole("dialog")).toBeTruthy();
	});
});
