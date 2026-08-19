import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import ConnectorManager from "./ConnectorManager";

const GRANT = {
	id: "g1",
	client: "claude.ai",
	clientId: "https://claude.ai/.well-known/oauth-client",
	scopes: ["projektor:read", "projektor:write"],
	grantedAt: 1_700_000_000,
	expiresAt: 1_702_592_000,
};

function stubFetch(grants: unknown[] = [GRANT]) {
	let listed = grants;
	const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
		if (init?.method === "DELETE") {
			listed = [];
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(listed) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("ConnectorManager", () => {
	it("names the application by the host of its client_id", async () => {
		stubFetch();
		render(<ConnectorManager workspaceSlug="my-ws" />);
		expect((await screen.findAllByText("claude.ai")).length).toBeGreaterThan(0);
		// Both the desktop table and the mobile card render, one hidden by CSS at each
		// width, so the access summary legitimately appears twice.
		expect(screen.getAllByText("Read + Write").length).toBeGreaterThan(0);
	});

	it("asks before disconnecting, and drops the row once confirmed", async () => {
		const fetchMock = stubFetch();
		render(<ConnectorManager workspaceSlug="my-ws" />);
		await screen.findAllByText("claude.ai");

		fireEvent.click(screen.getAllByRole("button", { name: /^Disconnect$/i })[0]);
		expect(screen.getAllByText(/Disconnect\?/i).length).toBeGreaterThan(0);

		fireEvent.click(screen.getAllByRole("button", { name: /^Yes$/i })[0]);
		expect(await screen.findByText(/No connected applications/i)).toBeTruthy();
		const deleted = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
		expect(String(deleted?.[0])).toContain("/api/workspaces/my-ws/connectors/g1");
	});

	it("explains how to get one when the list is empty", async () => {
		stubFetch([]);
		render(<ConnectorManager workspaceSlug="my-ws" />);
		expect(await screen.findByText(/No connected applications/i)).toBeTruthy();
		expect(screen.getByText(/Add this workspace as a connector in Claude/i)).toBeTruthy();
	});
});
