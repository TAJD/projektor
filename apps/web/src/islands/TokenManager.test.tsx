// TokenManager island — mock-fetch tests.
//
// TokenManager requires a workspaceSlug prop; without it, it renders a "No
// workspace configured." fallback immediately. When the slug is present it
// fetches the workspace info and token list via apiFetch (→ global fetch).
// The pattern: provide workspaceSlug prop, override the stub, await findBy*.
import { buildMcpAddCommandMultiline } from "@projektor/types";
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import TokenManager, { validateExpiryDays } from "./TokenManager";

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

	it("mcpAddCommandMultiline puts flags first and ends them with -- before the name/url (PROJ-620, PROJ-978)", () => {
		const command = buildMcpAddCommandMultiline({
			workspaceSlug: "my-ws",
			mcpUrl: "https://example.com/mcp/w1",
			token: "tok123",
		});
		expect(command).toBe(
			[
				"claude mcp add --transport http \\",
				'  --header "Authorization: Bearer tok123" \\',
				'  --header "X-Workspace-Slug: my-ws" \\',
				'  -- projektor "https://example.com/mcp/w1"',
			].join("\n")
		);
	});
});

// GOV.UK number-input pattern: the expiry field is free text (inputmode="numeric"), so
// validation is ours — an unparseable value must never silently mean "no expiry".
describe("validateExpiryDays", () => {
	it("accepts blank (no expiry) and whole days in range", () => {
		expect(validateExpiryDays("")).toBeNull();
		expect(validateExpiryDays(" 90 ")).toBeNull();
		expect(validateExpiryDays("1")).toBeNull();
		expect(validateExpiryDays("365")).toBeNull();
	});

	it("rejects non-numbers, decimals and out-of-range values with a message", () => {
		expect(validateExpiryDays("abc")).toMatch(/whole number of days/);
		expect(validateExpiryDays("1e3")).toMatch(/whole number of days/);
		expect(validateExpiryDays("2.5")).toMatch(/whole number of days/);
		expect(validateExpiryDays("0")).toMatch(/between 1 and 365/);
		expect(validateExpiryDays("400")).toMatch(/between 1 and 365/);
	});
});

describe("expiry field", () => {
	it("is a text input with a numeric keypad, not type=number", async () => {
		mockFetchTokens();
		render(<TokenManager workspaceSlug="ws" />);
		fireEvent.click(await screen.findByRole("button", { name: /New token/i }));
		const field = screen.getByLabelText(/Expires in/i) as HTMLInputElement;
		expect(field.type).toBe("text");
		expect(field.getAttribute("inputmode")).toBe("numeric");
	});

	it("shows an error instead of creating a never-expiring token from bad input", async () => {
		mockFetchTokens();
		render(<TokenManager workspaceSlug="ws" />);
		fireEvent.click(await screen.findByRole("button", { name: /New token/i }));
		fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: "ci" } });
		fireEvent.input(screen.getByLabelText(/Expires in/i), { target: { value: "ninety" } });
		const posts = () =>
			(fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
				(c) => (c[1] as RequestInit | undefined)?.method === "POST"
			);
		fireEvent.submit(screen.getByLabelText(/Expires in/i).closest("form") as HTMLFormElement);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toMatch(/whole number of days/);
		expect(posts()).toHaveLength(0);
	});
});
