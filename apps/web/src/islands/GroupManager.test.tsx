// GroupManager island — mock-fetch tests for the group rename control.
//
// The detail editor is admin-only, so the workspace stub reports currentUserRole
// "owner". Clicking the group name in the table opens the editor; the name input
// is seeded from the fetched detail.
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import GroupManager from "./GroupManager";

const GROUP = {
	id: "g1",
	name: "Engineering",
	description: null,
	memberCount: 1,
	grantCount: 1,
};

const DETAIL = {
	...GROUP,
	members: [{ userId: "u1", email: "alice@example.com", name: "Alice" }],
	grants: [{ projectId: "p1", projectName: "Apollo", projectKey: "APO", role: "member" }],
};

function mockFetch() {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		const json = (body: unknown) =>
			Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

		if (u.includes("/groups/g1")) {
			if (init?.method === "PATCH") return json({ ...DETAIL, name: "Platform" });
			return json(DETAIL);
		}
		if (u.includes("/member-groups")) return json([]);
		if (u.includes("/groups")) return json([GROUP]);
		if (u.includes("/api/projects")) return json([{ id: "p1", name: "Apollo", key: "APO" }]);
		return json({ currentUserRole: "owner", members: [] });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function openEditor() {
	fireEvent.click(await screen.findByRole("button", { name: "Engineering" }));
	return (await screen.findByLabelText(/Group name/i)) as HTMLInputElement;
}

describe("GroupManager rename", () => {
	it("seeds the name input from the loaded group detail", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		expect((await openEditor()).value).toBe("Engineering");
	});

	it("disables Rename until the name actually changes", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();
		const button = screen.getByRole("button", { name: /^Rename$/ }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);

		fireEvent.input(input, { target: { value: "Platform" } });
		expect(button.disabled).toBe(false);
	});

	it("keeps Rename disabled for a blank or whitespace-only name", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();
		fireEvent.input(input, { target: { value: "   " } });
		expect((screen.getByRole("button", { name: /^Rename$/ }) as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it("PATCHes the group with the trimmed name", async () => {
		const fetchMock = mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();

		fireEvent.input(input, { target: { value: "  Platform  " } });
		fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));

		await vi.waitFor(() => {
			const patch = fetchMock.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
			);
			expect(patch).toBeTruthy();
			expect(String(patch?.[0])).toContain("/groups/g1");
			expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ name: "Platform" });
		});
	});
});

// PROJ-343: Members and Groups now render as separate tabs, defaulting to
// Groups so the flows above stay reachable without switching tabs first.
const REGULAR_MEMBER = { id: "u2", email: "mo@example.com", name: "Mo Member", role: "member" };

function mockFetchForTabs(opts: { role: string }) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			const json = (body: unknown) =>
				Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			if (u.includes("/member-groups")) {
				return json([{ userId: "u2", groups: [{ id: "g1", name: "Engineering" }] }]);
			}
			if (u.includes("/groups")) return json([GROUP]);
			if (u.includes("/api/projects")) return json([]);
			return json({ members: [REGULAR_MEMBER], currentUserRole: opts.role });
		})
	);
}

describe("GroupManager tabs", () => {
	it("renders both Members and Groups tabs for an admin, defaulting to Groups", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);

		const groupsTab = await screen.findByRole("tab", { name: "Groups" });
		const membersTab = screen.getByRole("tab", { name: "Members" });
		expect(groupsTab.getAttribute("aria-selected")).toBe("true");
		expect(membersTab.getAttribute("aria-selected")).toBe("false");

		expect(screen.getByText("Engineering")).toBeTruthy();
		expect(screen.queryByText("Mo Member")).toBeNull();
	});

	it("shows the Members panel and hides Groups when the Members tab is clicked", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);

		await screen.findByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		expect(await screen.findByText("Mo Member")).toBeTruthy();
		expect(screen.queryByPlaceholderText("New group name")).toBeNull();
		expect(screen.getByRole("tab", { name: "Members" }).getAttribute("aria-selected")).toBe("true");
	});

	it("shows no Members tab (or tablist) for a non-admin caller", async () => {
		mockFetchForTabs({ role: "member" });
		render(<GroupManager workspaceSlug="my-ws" />);

		await screen.findByText("Your groups");
		expect(screen.queryByRole("tab", { name: "Members" })).toBeNull();
		expect(screen.queryByRole("tablist")).toBeNull();
	});
});
