import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

function stubMeFetch(outcome: { ok: true; name: string; email: string } | { ok: false }) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("/auth/me")) {
				if (!outcome.ok) return Promise.reject(new Error("network down"));
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({ user: { id: "u1", name: outcome.name, email: outcome.email } }),
				});
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AccountMenu — loading and error states", () => {
	it("shows a disabled, labeled placeholder while /auth/me is loading", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<AccountMenu />);
		const trigger = screen.getByRole("button", { name: "Loading account" });
		expect(trigger).toBeTruthy();
		expect(trigger.hasAttribute("disabled")).toBe(true);
	});

	it("falls back to a plain Log in link when /auth/me fails", async () => {
		stubMeFetch({ ok: false });
		render(<AccountMenu />);
		const link = await screen.findByRole("link", { name: "Log in" });
		expect(link.getAttribute("href")).toBe("/auth/login");
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("AccountMenu — signed-in state", () => {
	it("shows the signed-in user's name on the trigger once loaded", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		expect(await screen.findByRole("button", { name: /Jane Doe/ })).toBeTruthy();
	});

	it("opens an accessible menu with Refresh session and Log out", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		const trigger = await screen.findByRole("button", { name: /Jane Doe/ });

		fireEvent.click(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const menu = screen.getByRole("menu", { name: "Account" });
		expect(menu).toBeTruthy();

		const refresh = screen.getByRole("menuitem", { name: "Refresh session" });
		expect(refresh.getAttribute("href")).toBe(
			`/auth/login?redirect_url=${encodeURIComponent(window.location.href)}`
		);

		const logout = screen.getByRole("menuitem", { name: "Log out" });
		expect(logout.getAttribute("href")).toBe("/cdn-cgi/access/logout");
	});

	it("portals the menu onto document.body with fixed positioning", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));

		const menu = screen.getByRole("menu", { name: "Account" });
		expect(menu.closest("[style]")?.parentElement).toBe(document.body);
		const popover = menu.parentElement as HTMLElement;
		expect(popover.style.position).toBe("fixed");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		const trigger = await screen.findByRole("button", { name: /Jane Doe/ });
		fireEvent.click(trigger);
		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });

		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on an outside click", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));
		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();

		fireEvent.mouseDown(document.body);

		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("does not close on a click inside the menu itself", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));
		const menu = screen.getByRole("menu", { name: "Account" });

		fireEvent.mouseDown(menu);

		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();
	});
});
