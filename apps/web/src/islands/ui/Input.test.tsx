import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Input, Textarea } from "./Input";

describe("Input", () => {
	it("renders with the base class", () => {
		render(<Input placeholder="Name" />);
		const input = screen.getByPlaceholderText("Name");
		expect(input.className).toContain("w-full");
		expect(input.className).toContain("border-border");
	});

	it("appends an extra class", () => {
		render(<Input placeholder="Name" class="extra-class" />);
		const input = screen.getByPlaceholderText("Name");
		expect(input.className).toContain("extra-class");
	});

	it("reflects value and calls onInput on change", () => {
		let value = "";
		render(
			<Input
				placeholder="Name"
				value="hello"
				onInput={(e) => (value = (e.target as HTMLInputElement).value)}
			/>
		);
		const input = screen.getByPlaceholderText("Name") as HTMLInputElement;
		expect(input.value).toBe("hello");
		fireEvent.input(input, { target: { value: "world" } });
		expect(value).toBe("world");
	});

	it("reflects disabled and applies disabled classes", () => {
		render(<Input placeholder="Name" disabled />);
		const input = screen.getByPlaceholderText("Name") as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect(input.className).toContain("disabled:opacity-60");
		expect(input.className).toContain("disabled:cursor-not-allowed");
	});
});

describe("Textarea", () => {
	it("renders a textarea element with rows forwarded", () => {
		render(<Textarea placeholder="Description" rows={5} />);
		const textarea = screen.getByPlaceholderText("Description") as HTMLTextAreaElement;
		expect(textarea.tagName).toBe("TEXTAREA");
		expect(textarea.rows).toBe(5);
	});
});
