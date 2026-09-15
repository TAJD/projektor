import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

describe("Dialog", () => {
	it("renders nothing when closed", () => {
		render(
			<Dialog open={false} onClose={() => {}} ariaLabel="Test dialog">
				<p>Body</p>
			</Dialog>
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders the panel with role=dialog and aria-modal when open", () => {
		render(
			<Dialog open={true} onClose={() => {}} ariaLabel="Test dialog">
				<p>Body</p>
			</Dialog>
		);
		const dialog = screen.getByRole("dialog", { name: "Test dialog" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(screen.getByText("Body")).toBeTruthy();
	});

	it("calls onClose on Escape", () => {
		const onClose = vi.fn();
		render(
			<Dialog open={true} onClose={onClose} ariaLabel="Test dialog">
				<p>Body</p>
			</Dialog>
		);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("calls onClose on backdrop click but not on panel click", () => {
		const onClose = vi.fn();
		render(
			<Dialog open={true} onClose={onClose} ariaLabel="Test dialog">
				<p>Body</p>
			</Dialog>
		);
		fireEvent.click(screen.getByText("Body"));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("moves initial focus into the panel and locks body scroll", () => {
		render(
			<Dialog open={true} onClose={() => {}} ariaLabel="Test dialog">
				<button type="button">First</button>
			</Dialog>
		);
		expect(document.activeElement?.textContent).toBe("First");
		expect(document.body.style.overflow).toBe("hidden");
	});

	it("does not close on Escape when a nested handler already handled it", () => {
		const onClose = vi.fn();
		const preventOnEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") e.preventDefault();
		};
		document.addEventListener("keydown", preventOnEscape);
		render(
			<Dialog open={true} onClose={onClose} ariaLabel="Test dialog">
				<p>Body</p>
			</Dialog>
		);
		fireEvent.keyDown(document, { key: "Escape" });
		document.removeEventListener("keydown", preventOnEscape);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("recaptures focus into the panel when Tab is pressed while focus has left it", () => {
		render(
			<Dialog open={true} onClose={() => {}} ariaLabel="Test dialog">
				<button type="button">First</button>
				<button type="button">Last</button>
			</Dialog>
		);
		(document.body as unknown as HTMLElement).focus();
		fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement?.textContent).toBe("First");

		(document.body as unknown as HTMLElement).focus();
		fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement?.textContent).toBe("Last");
	});

	it("traps Tab focus between the first and last focusable elements", () => {
		render(
			<Dialog open={true} onClose={() => {}} ariaLabel="Test dialog">
				<button type="button">First</button>
				<button type="button">Last</button>
			</Dialog>
		);
		const last = screen.getByText("Last");
		last.focus();
		fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement?.textContent).toBe("First");

		const first = screen.getByText("First");
		first.focus();
		fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement?.textContent).toBe("Last");
	});
});
