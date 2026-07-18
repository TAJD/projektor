import { act, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "./OfflineBanner";

describe("OfflineBanner", () => {
	let onLineSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
	});

	afterEach(() => {
		onLineSpy.mockRestore();
	});

	it("renders nothing while online", () => {
		render(<OfflineBanner />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows a banner on the offline event and hides it again on online", () => {
		onLineSpy.mockReturnValue(false);
		render(<OfflineBanner />);
		act(() => {
			window.dispatchEvent(new Event("offline"));
		});

		expect(screen.getByRole("status").textContent).toMatch(/offline/i);

		act(() => {
			window.dispatchEvent(new Event("online"));
		});
		expect(screen.queryByRole("status")).toBeNull();
	});
});
