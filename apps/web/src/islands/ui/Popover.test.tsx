import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { Popover } from "./Popover";

afterEach(cleanup);

describe("Popover", () => {
	// Importing preact/compat anywhere in an island's graph switches Preact to React's
	// event semantics for that whole island. Popover now sits in the module graph of
	// AccountMenu (topbar, every page), GlossaryHelp, MetricHelp, and SavedViewsControl —
	// see LazyMarkdownEditor.test.tsx's PROJ-431 guard and Popover.tsx's PROJ-552 comment.
	it("does not import preact/compat", () => {
		const source = readFileSync(join(__dirname, "Popover.tsx"), "utf-8");
		expect(source).not.toMatch(/^import\s[^;]*"preact\/compat"/m);
	});

	it("removes the portaled node from document.body when the Popover unmounts", () => {
		const { rerender } = render(
			<Popover strategy="portal-fixed" position={{ top: 10 }}>
				<span>Unmount me</span>
			</Popover>
		);
		const el = screen.getByText("Unmount me").parentElement as HTMLElement;
		expect(document.body.contains(el)).toBe(true);

		rerender(<div />);
		expect(document.body.contains(el)).toBe(false);
	});

	it("updates the portaled content when children change on re-render", () => {
		const { rerender } = render(
			<Popover strategy="portal-fixed" position={{ top: 10 }}>
				<span>First content</span>
			</Popover>
		);
		expect(screen.getByText("First content")).toBeTruthy();

		rerender(
			<Popover strategy="portal-fixed" position={{ top: 10 }}>
				<span>Second content</span>
			</Popover>
		);
		expect(screen.queryByText("First content")).toBeNull();
		expect(screen.getByText("Second content")).toBeTruthy();
	});

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

	it("throws without `position` when strategy is 'portal-fixed'", () => {
		expect(() => render(<Popover strategy="portal-fixed">No position</Popover>)).toThrow();
	});

	it("resolves elementRef to the rendered DOM element when anchored", () => {
		const elementRef = { current: null as HTMLElement | null };
		render(
			<Popover strategy="anchored" elementRef={elementRef}>
				<span>Ref content</span>
			</Popover>
		);
		const el = screen.getByText("Ref content").parentElement as HTMLElement;
		expect(elementRef.current).toBe(el);
	});

	it("resolves elementRef to the portaled DOM node under document.body when portal-fixed", () => {
		const elementRef = { current: null as HTMLElement | null };
		render(
			<Popover strategy="portal-fixed" position={{ top: 10 }} elementRef={elementRef}>
				<span>Portal ref content</span>
			</Popover>
		);
		const el = screen.getByText("Portal ref content").parentElement as HTMLElement;
		expect(document.body.contains(el)).toBe(true);
		expect(elementRef.current).toBe(el);
	});

	it('round-trips aria-modal="false" when ariaModal={false} and role are both passed', () => {
		render(
			<Popover strategy="anchored" role="dialog" ariaModal={false}>
				<span>Dialog content</span>
			</Popover>
		);
		const el = screen.getByText("Dialog content").parentElement as HTMLElement;
		expect(el.getAttribute("aria-modal")).toBe("false");
		expect(el.getAttribute("role")).toBe("dialog");
	});

	it("renders ariaLabel even when role is omitted", () => {
		render(
			<Popover strategy="anchored" ariaLabel="Definition">
				<span>Label-only content</span>
			</Popover>
		);
		const el = screen.getByText("Label-only content").parentElement as HTMLElement;
		expect(el.getAttribute("aria-label")).toBe("Definition");
		expect(el.hasAttribute("role")).toBe(false);
	});

	it("renders role even when ariaLabel is omitted", () => {
		render(
			<Popover strategy="anchored" role="menu">
				<span>Role-only content</span>
			</Popover>
		);
		const el = screen.getByText("Role-only content").parentElement as HTMLElement;
		expect(el.getAttribute("role")).toBe("menu");
		expect(el.hasAttribute("aria-label")).toBe(false);
	});
});
