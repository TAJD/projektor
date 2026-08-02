import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Popover } from "./Popover";

describe("Popover", () => {
	it("renders in place with no portal and no inline position style when anchored", () => {
		const { container } = render(
			<Popover strategy="anchored">
				<span>Anchored content</span>
			</Popover>
		);
		const el = screen.getByText("Anchored content").parentElement as HTMLElement;
		expect(container.contains(el)).toBe(true);
		expect(el.style.position).toBe("");
	});

	it("portals to document.body with the caller-computed position", () => {
		const { container } = render(
			<Popover strategy="portal-fixed" position={{ top: 10, left: 20, right: 30, width: 40 }}>
				<span>Portal content</span>
			</Popover>
		);
		const el = screen.getByText("Portal content").parentElement as HTMLElement;
		expect(container.contains(el)).toBe(false);
		expect(document.body.contains(el)).toBe(true);
		expect(el.style.top).toBe("10px");
		expect(el.style.left).toBe("20px");
		expect(el.style.right).toBe("30px");
		expect(el.style.minWidth).toBe("40px");
	});

	it("stays in the render container with an inline fixed position when fixed-inline", () => {
		const { container } = render(
			<Popover strategy="fixed-inline" position={{ top: 10, left: 20 }}>
				<span>Inline fixed content</span>
			</Popover>
		);
		const el = screen.getByText("Inline fixed content").parentElement as HTMLElement;
		expect(container.contains(el)).toBe(true);
		expect(el.style.position).toBe("fixed");
	});

	it("renders no ARIA attributes when role is omitted", () => {
		const { container } = render(
			<Popover strategy="anchored">
				<span>No aria</span>
			</Popover>
		);
		const el = screen.getByText("No aria").parentElement as HTMLElement;
		expect(el.hasAttribute("role")).toBe(false);
		expect(el.hasAttribute("aria-label")).toBe(false);
		expect(container).toBeTruthy();
	});

	it("throws without `position` when strategy is 'portal-fixed' or 'fixed-inline'", () => {
		expect(() => render(<Popover strategy="portal-fixed">No position</Popover>)).toThrow();
		expect(() => render(<Popover strategy="fixed-inline">No position</Popover>)).toThrow();
	});
});
