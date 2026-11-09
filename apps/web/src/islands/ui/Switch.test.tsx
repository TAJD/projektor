import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

describe("Switch (NN/g: immediate-effect binary setting)", () => {
	it("is a named role=switch reflecting its state", () => {
		render(<Switch checked={false} onChange={() => {}} label="Show archived" />);
		const sw = screen.getByRole("switch", { name: "Show archived" });
		expect(sw.getAttribute("aria-checked")).toBe("false");
		// Label text stays findable for label-based queries.
		expect(screen.getByLabelText("Show archived")).toBe(sw);
	});

	it("reports the toggled value on click", () => {
		const onChange = vi.fn();
		render(<Switch checked={true} onChange={onChange} label="Include done" />);
		fireEvent.click(screen.getByRole("switch", { name: "Include done" }));
		expect(onChange).toHaveBeenCalledWith(false);
	});
});
