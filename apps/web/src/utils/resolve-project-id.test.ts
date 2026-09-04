import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUrlProjectId, resolveProjectId } from "./resolve-project-id";

const PROJECTS = [
	{ id: "p1", key: "PROJ", name: "Projektor" },
	{ id: "p2", key: "OTHER", name: "Other" },
];

function mockProjects(list: readonly unknown[] = PROJECTS) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(list) })
	);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

afterEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

describe("readUrlProjectId", () => {
	it("reads ?projectId= first, then ?id=", () => {
		history.replaceState(null, "", "?id=fromId");
		expect(readUrlProjectId()).toBe("fromId");
		history.replaceState(null, "", "?projectId=fromProjectId&id=fromId");
		expect(readUrlProjectId()).toBe("fromProjectId");
	});

	it("returns null when neither param is present", () => {
		expect(readUrlProjectId()).toBeNull();
	});
});

describe("resolveProjectId", () => {
	it("resolves a valid URL hint, persists it to localStorage and the URL", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, "p2");
		expect(res.project).toEqual(PROJECTS[1]);
		expect(res.error).toBeNull();
		expect(localStorage.getItem("projektor-last-project-id")).toBe("p2");
		expect(new URLSearchParams(window.location.search).get("projectId")).toBe("p2");
	});

	it("returns an error (not a silent null) for an unknown URL hint", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, "does-not-exist");
		expect(res.project).toBeNull();
		expect(res.error).toBe("Project not found");
		expect(localStorage.getItem("projektor-last-project-id")).toBeNull();
	});

	it("falls back to a validated stored id when there is no URL hint", async () => {
		localStorage.setItem("projektor-last-project-id", "p2");
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[1]);
		expect(res.error).toBeNull();
	});

	it("falls through a stale stored id to the first project, rather than erroring", async () => {
		localStorage.setItem("projektor-last-project-id", "stale-id");
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[0]);
		expect(res.error).toBeNull();
		expect(localStorage.getItem("projektor-last-project-id")).toBe("p1");
	});

	it("falls back to the first project when there is no stored id", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[0]);
	});

	it("resolves to null without an error when the workspace has no projects", async () => {
		mockProjects([]);
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toBeNull();
		expect(res.error).toBeNull();
	});

	it("surfaces a fetch failure as an error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toBeNull();
		expect(res.error).toBe("Failed to load projects");
	});

	it("accepts a custom matcher, e.g. to resolve a hint by key as well as id", async () => {
		mockProjects();
		const res = await resolveProjectId(
			undefined,
			"OTHER",
			(p: (typeof PROJECTS)[number], hint) => p.id === hint || p.key === hint
		);
		expect(res.project).toEqual(PROJECTS[1]);
	});
});
