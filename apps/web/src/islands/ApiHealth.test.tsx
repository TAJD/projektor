import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApiHealth from "./ApiHealth";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("ApiHealth — smoke test", () => {
	it("renders the API status label on mount", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
		);
		render(<ApiHealth />);
		expect(screen.getByText(/API status:/)).toBeTruthy();
	});

	it("renders the initial checking state before fetch resolves", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ApiHealth />);
		expect(screen.getByText(/checking/i)).toBeTruthy();
	});
});
