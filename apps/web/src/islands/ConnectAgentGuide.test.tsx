import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import ConnectAgentGuide from "./ConnectAgentGuide";

function stubFetch(mcpUrl = "https://projektor.example.workers.dev/mcp/w1") {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ mcpUrl }) })
	);
}

describe("ConnectAgentGuide", () => {
	it("renders nothing without a workspace slug", () => {
		const { container } = render(<ConnectAgentGuide />);
		expect(container.textContent).toBe("");
	});

	it("shows the connect steps immediately, before the URL loads", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ConnectAgentGuide workspaceSlug="my-ws" />);
		expect(screen.getByText(/Add custom connector/i)).toBeTruthy();
		expect(screen.getByText(/\(loading…\)/i)).toBeTruthy();
	});

	it("shows the workspace's MCP URL once it loads, with a copy button", async () => {
		stubFetch("https://projektor.example.workers.dev/mcp/w1");
		render(<ConnectAgentGuide workspaceSlug="my-ws" />);
		expect(await screen.findByText("https://projektor.example.workers.dev/mcp/w1")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Copy/i })).toBeTruthy();
	});

	it("says access is auto-scoped, with no token or admin step needed", async () => {
		stubFetch();
		render(<ConnectAgentGuide workspaceSlug="my-ws" />);
		expect(await screen.findByText(/no token or admin step needed/i)).toBeTruthy();
	});
});
