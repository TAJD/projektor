// TokenManager island — mock-fetch tests.
//
// TokenManager requires a workspaceSlug prop; without it, it renders a "No
// workspace configured." fallback immediately. When the slug is present it
// fetches the workspace info and token list via apiFetch (→ global fetch).
// The pattern: provide workspaceSlug prop, override the stub, await findBy*.
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import TokenManager from "./TokenManager";

const TOKEN = {
	id: "t1",
	name: "Claude agent",
	scopes: '["read","write"]',
	lastUsedAt: null,
	expiresAt: null,
	createdAt: 1000,
};

function mockFetchTokens(tokens: readonly (typeof TOKEN)[] = [TOKEN]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/tokens")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(tokens) });
			}
			if (u.includes("/mcp-info")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ mcpAddCommandTemplate: null }),
				});
			}
			// workspace info
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "w1" }) });
		})
	);
}

describe("TokenManager", () => {
	it("shows 'No workspace configured.' when workspaceSlug prop is absent", () => {
		render(<TokenManager />);
		expect(screen.getByText(/No workspace configured/i)).toBeTruthy();
	});

	it("renders loading state while tokens are being fetched", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<TokenManager workspaceSlug="my-ws" />);
		expect(screen.getByText(/Loading tokens/i)).toBeTruthy();
	});

	it("renders token names and scope after fetch resolves", async () => {
		mockFetchTokens([TOKEN]);
		render(<TokenManager workspaceSlug="my-ws" />);
		expect(await screen.findAllByText("Claude agent")).not.toHaveLength(0);
		expect(screen.getAllByText("Read + Write").length).toBeGreaterThan(0);
	});

	it("renders a mobile-card fallback alongside the desktop table", async () => {
		mockFetchTokens([TOKEN]);
		render(<TokenManager workspaceSlug="my-ws" />);
		// Desktop table + mobile card both render (CSS hides one per viewport;
		// jsdom doesn't evaluate CSS, see apps/web/src/test/viewport.ts).
		expect((await screen.findAllByText("Claude agent")).length).toBe(2);
	});

	it("shows empty state when no tokens exist", async () => {
		mockFetchTokens([]);
		render(<TokenManager workspaceSlug="my-ws" />);
		expect(await screen.findByText(/No API tokens yet/i)).toBeTruthy();
	});

	it("shows '+ New token' button in the header row", async () => {
		mockFetchTokens([]);
		render(<TokenManager workspaceSlug="my-ws" />);
		await screen.findByText(/No API tokens yet/i);
		expect(screen.getByRole("button", { name: /New token/i })).toBeTruthy();
	});

	it("reveals the create form when '+ New token' is clicked", async () => {
		mockFetchTokens([]);
		render(<TokenManager workspaceSlug="my-ws" />);
		await screen.findByText(/No API tokens yet/i);

		fireEvent.click(screen.getByRole("button", { name: /New token/i }));
		expect(await screen.findByText("New API token")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Create token/i })).toBeTruthy();
	});
});
