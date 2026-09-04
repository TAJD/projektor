// SprintManager island — mock-fetch tests.
//
// SprintManager reads ?projectId= from the URL, then fetches /api/projects/:id
// and /api/sprints?projectId=... in parallel via raw fetch + buildHeaders.
// loading starts as true so the loading state is immediately visible.
// The pattern: set the URL, override the stub, await findBy*.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetProjectStoreForTests } from "../lib/project-context";
import SprintManager, { type Sprint } from "./SprintManager";

const PROJECT = { id: "p1", name: "Projektor", key: "PROJ" };

const SPRINT: Sprint = {
	id: "s1",
	name: "Sprint 1",
	goal: "Ship it",
	status: "planned",
	startDate: null,
	endDate: null,
	projectId: "p1",
	createdAt: 1000,
};

function mockFetchSprints(
	sprints: readonly Sprint[] = [SPRINT],
	projects: readonly (typeof PROJECT)[] = [PROJECT]
) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.endsWith("/api/projects")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(projects) });
			}
			if (u.includes("/api/projects/")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECT) });
			}
			if (u.includes("/api/sprints")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: sprints }) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		})
	);
}

beforeEach(() => {
	__resetProjectStoreForTests();
	history.replaceState(null, "", "/");
});

afterEach(() => {
	history.replaceState(null, "", "/");
});

describe("SprintManager", () => {
	it("renders loading state initially when a projectId is present", () => {
		// loading starts true — visible immediately without any fetch resolving
		history.replaceState(null, "", "?projectId=p1");
		mockFetchSprints([]);
		render(<SprintManager />);
		expect(screen.getByText(/Loading sprints/i)).toBeTruthy();
	});

	it("shows 'No project specified' instead of hanging when no projectId is in the URL and no fallback resolves (PROJ-424)", async () => {
		mockFetchSprints([], []);
		render(<SprintManager />);
		expect(await screen.findByText(/No project specified/i)).toBeTruthy();
		expect(screen.queryByText(/Loading sprints/i)).toBeNull();
	});

	it("renders sprint list after fetch resolves", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchSprints([SPRINT]);
		render(<SprintManager />);
		expect(await screen.findByText("Sprint 1")).toBeTruthy();
		expect(screen.getByText("Ship it")).toBeTruthy();
	});

	it("falls back to the stored project id when no URL param is present, matching ProjectNav (PROJ-723)", async () => {
		localStorage.setItem("projektor-last-project-id", "p1");
		mockFetchSprints([SPRINT]);
		render(<SprintManager />);
		expect(await screen.findByText("Sprint 1")).toBeTruthy();
		localStorage.removeItem("projektor-last-project-id");
	});

	it("shows empty state when no sprints are returned", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchSprints([]);
		render(<SprintManager />);
		expect(await screen.findByText(/No sprints yet/i)).toBeTruthy();
	});

	it("renders the create sprint form when '+ New sprint' is clicked", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchSprints([]);
		render(<SprintManager />);
		await screen.findByText(/No sprints yet/i);

		fireEvent.click(screen.getByRole("button", { name: /New sprint/i }));
		expect(await screen.findByText("New sprint")).toBeTruthy();
		expect(screen.getByLabelText(/Name/i)).toBeTruthy();
	});

	it("calls POST /api/sprints when the create form is submitted", async () => {
		history.replaceState(null, "", "?projectId=p1");
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.endsWith("/api/projects")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([PROJECT]) });
			}
			if (u.includes("/api/projects/")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECT) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
		});
		vi.stubGlobal("fetch", mockFetch);

		render(<SprintManager />);
		await screen.findByText(/No sprints yet/i);

		fireEvent.click(screen.getByRole("button", { name: /New sprint/i }));
		await screen.findByText("New sprint");

		fireEvent.input(screen.getByLabelText(/Name/i), {
			target: { value: "Sprint 2" },
		});

		const form = screen.getByRole("button", { name: /Create sprint/i }).closest("form");
		if (!form) throw new Error("Create sprint form not found");
		fireEvent.submit(form);

		await waitFor(() => {
			const calls = mockFetch.mock.calls as [string, RequestInit][];
			const postCall = calls.find(
				([url, init]) => String(url).includes("/api/sprints") && init?.method === "POST"
			);
			expect(postCall).toBeDefined();
		});
	});
});
