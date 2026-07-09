// PROJ-315: the access-pending gate. A non-admin caller whose visible-project
// set is empty should see the "access pending" panel instead of a bare empty
// list; an admin of an empty workspace keeps the normal empty state; anyone with
// projects sees the list. useAccessGate drives all three surfaces, so exercising
// it through ProjectList covers the shared behaviour.
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import AccessPending from "./AccessPending";
import ProjectList from "./ProjectList";

function routeFetch(routes: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			const path = new URL(url, "http://localhost").pathname;
			const body = path in routes ? routes[path] : {};
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		})
	);
}

const PROJECT = {
	id: "p1",
	name: "Projektor",
	key: "PROJ",
	description: null,
	workspace_id: "w1",
	workspace_name: "WS",
	workspace_slug: "ws",
	open_issue_count: 0,
	created_at: 0,
	updated_at: 0,
};

describe("AccessPending", () => {
	it("renders the pending panel", () => {
		render(<AccessPending />);
		expect(screen.getByText(/Access pending/i)).toBeTruthy();
	});
});

describe("useAccessGate via ProjectList", () => {
	it("shows the pending panel for a non-admin with no visible projects", async () => {
		routeFetch({ "/api/projects": [], "/api/workspaces/ws": { currentUserRole: "member" } });
		render(<ProjectList workspaceSlug="ws" />);
		expect(await screen.findByText(/Access pending/i)).toBeTruthy();
	});

	it("keeps the normal empty state for an admin of an empty workspace", async () => {
		routeFetch({ "/api/projects": [], "/api/workspaces/ws": { currentUserRole: "owner" } });
		render(<ProjectList workspaceSlug="ws" />);
		expect(await screen.findByText(/No projects yet/i)).toBeTruthy();
		expect(screen.queryByText(/Access pending/i)).toBeNull();
	});

	it("does not gate a non-admin who has visible projects", async () => {
		routeFetch({ "/api/projects": [PROJECT], "/api/workspaces/ws": { currentUserRole: "member" } });
		render(<ProjectList workspaceSlug="ws" />);
		expect(await screen.findByText("Projektor")).toBeTruthy();
		expect(screen.queryByText(/Access pending/i)).toBeNull();
	});
});
