// ProjectList island — canonical mock-fetch test (list-rendering variant).
//
// ProjectList fetches /api/projects on mount and renders loading / error / empty /
// populated states. The pattern: override the default fetch stub from setup.ts per
// case with vi.stubGlobal, then await findBy* for the async state transition.
// A never-resolving fetch lets us assert the synchronous loading state.
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import ProjectList from "./ProjectList";

function mockFetchOk(payload: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) })
	);
}

function mockFetchByUrl(routes: { projects: unknown[]; meEmail: string }) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ user: { id: "u1", email: routes.meEmail, name: "User" } }),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(routes.projects) });
		})
	);
}

const PROJECT = {
	id: "p1",
	name: "Projektor",
	key: "PROJ",
	description: "An issue tracker",
	workspace_id: "w1",
	workspace_name: "WS",
	workspace_slug: "ws",
	open_issue_count: 3,
	created_at: 0,
	updated_at: 0,
};

describe("ProjectList", () => {
	it("shows the loading state before the fetch resolves", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ProjectList />);
		expect(screen.getByText(/Loading projects/i)).toBeTruthy();
	});

	it("shows the empty state when no projects are returned", async () => {
		mockFetchOk([]);
		render(<ProjectList />);
		expect(await screen.findByText(/No projects yet/i)).toBeTruthy();
	});

	it("renders a card with the project name, key and open-issue count", async () => {
		mockFetchOk([PROJECT]);
		render(<ProjectList />);
		expect(await screen.findByText("Projektor")).toBeTruthy();
		expect(screen.getByText("PROJ")).toBeTruthy();
		expect(screen.getByText("3 open issues")).toBeTruthy();
	});

	it("shows an error message when the request fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
		render(<ProjectList />);
		expect(await screen.findByText(/Failed to load projects/i)).toBeTruthy();
	});
});

// PROJ-568: the public read-only demo viewer (PROJ-373) must not be offered a
// "+ New project" action that always fails the POST — see apps/api/src/middleware/auth.ts.
describe("ProjectList — public read-only demo viewer (PROJ-568)", () => {
	it("hides the create-project button for the public viewer", async () => {
		mockFetchByUrl({ projects: [], meEmail: "public-viewer@projektor.local" });
		render(<ProjectList />);
		await screen.findByText(/No projects yet/i);
		expect(await screen.findByText(/Read-only demo/i)).toBeTruthy();
		expect(screen.queryByText("+ New project")).toBeNull();
	});

	it("shows the create-project button for a real user", async () => {
		mockFetchByUrl({ projects: [], meEmail: "real-user@example.com" });
		render(<ProjectList />);
		await screen.findByText(/No projects yet/i);
		expect(await screen.findByText("+ New project")).toBeTruthy();
		expect(screen.queryByText(/Read-only demo/i)).toBeNull();
	});
});
