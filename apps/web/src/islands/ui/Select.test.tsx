// Select island — canonical interaction test.
//
// Select renders no network, so this is the simplest pattern: render with props,
// drive it with fireEvent, assert on rendered text and the onChange spy.
// Cleanup + global restore happen in src/test/setup.ts.
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import Select, { type SelectOption } from "./Select";

const OPTIONS: SelectOption[] = [
	{ value: "open", label: "Open" },
	{ value: "done", label: "Done" },
];

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
