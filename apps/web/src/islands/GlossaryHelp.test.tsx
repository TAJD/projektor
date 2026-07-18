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
});
