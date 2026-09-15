import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
	it("renders the label and associates it with the control via htmlFor", () => {
		render(
			<Field label="Name" htmlFor="field-name">
				<input id="field-name" />
			</Field>
		);
		const input = screen.getByLabelText("Name");
		expect(input.id).toBe("field-name");
	});

	it("renders the required marker", () => {
		render(
			<Field label="Key" htmlFor="field-key" required>
				<input id="field-key" />
			</Field>
		);
		const marker = screen.getByText("*", { exact: false });
		expect(marker.getAttribute("aria-hidden")).toBe("true");
		expect(marker.className).toBe("text-accent");
	});

	it("renders error text with role=alert and error styling instead of help", () => {
		render(
			<Field label="Name" htmlFor="field-name" help="A helpful hint" error="Name is required">
				<input id="field-name" />
			</Field>
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Name is required");
		expect(alert.className).toContain("text-danger-text");
		expect(screen.queryByText("A helpful hint")).toBeNull();
	});

	it("renders help text when no error is present", () => {
		render(
			<Field label="Name" htmlFor="field-name" help="A helpful hint">
				<input id="field-name" />
			</Field>
		);
		expect(screen.getByText("A helpful hint")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("renders children inside the field", () => {
		render(
			<Field label="Name" htmlFor="field-name">
				<input id="field-name" placeholder="Type here" />
			</Field>
		);
		expect(screen.getByPlaceholderText("Type here")).toBeTruthy();
	});
});
