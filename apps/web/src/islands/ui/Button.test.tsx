import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
	it("renders the bare .btn class when no variant is given", () => {
		render(<Button>Click me</Button>);
		const button = screen.getByRole("button", { name: "Click me" });
		expect(button.className).toBe("btn");
	});

	it("applies the variant and size classes", () => {
		render(
			<Button variant="primary" size="sm">
				Save
			</Button>
		);
		const button = screen.getByRole("button", { name: "Save" });
		expect(button.className).toBe("btn btn-primary btn-sm");
	});

	it("passes through an extra class", () => {
		render(<Button class="icon-reset">Icon</Button>);
		const button = screen.getByRole("button", { name: "Icon" });
		expect(button.className).toBe("btn icon-reset");
	});

	it("fires onClick when clicked", () => {
		let clicked = false;
		render(<Button onClick={() => (clicked = true)}>Go</Button>);
		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		expect(clicked).toBe(true);
	});

	it("renders a span, not a button, when as='span'", () => {
		render(<Button as="span">Label</Button>);
		expect(screen.queryByRole("button")).toBeNull();
		const span = screen.getByText("Label");
		expect(span.tagName).toBe("SPAN");
	});

	it("supports disabled on the button element", () => {
		render(<Button disabled>Wait</Button>);
		const button = screen.getByRole("button", { name: "Wait" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it("renders an anchor with href when as='a', and throws without href", () => {
		render(
			<Button as="a" href="/sprints/1/start">
				Start sprint
			</Button>
		);
		const link = screen.getByRole("link", { name: "Start sprint" }) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/sprints/1/start");

		expect(() => render(<Button as="a">No href</Button>)).toThrow();
	});
});
