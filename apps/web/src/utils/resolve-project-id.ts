import { apiFetch } from "./api-client";

const STORAGE_KEY = "projektor-last-project-id";

export interface ProjectIdCandidate {
	id: string;
}

export interface ResolveProjectIdResult<T extends ProjectIdCandidate> {
	project: T | null;
	projects: T[];
	error: string | null;
}

export function readUrlProjectId(): string | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	return params.get("projectId") || params.get("id");
}

export function persistProjectId(id: string): void {
	localStorage.setItem(STORAGE_KEY, id);
	const params = new URLSearchParams(window.location.search);
	if (params.get("projectId") !== id) {
		params.set("projectId", id);
		history.replaceState(null, "", `?${params.toString()}`);
	}
}

export async function fetchProjects<T extends ProjectIdCandidate>(
	workspaceSlug: string | undefined
): Promise<T[]> {
	const list = await apiFetch<T[]>("/api/projects", { workspaceSlug });
	return Array.isArray(list) ? list : [];
}

export function matchProjectId<T extends ProjectIdCandidate>(
	projects: readonly T[],
	urlHint: string | null,
	matches: (project: T, hint: string) => boolean = (p, hint) => p.id === hint
): { project: T | null; error: string | null } {
	if (urlHint) {
		const matched = projects.find((p) => matches(p, urlHint)) ?? null;
		if (matched) {
			persistProjectId(matched.id);
			return { project: matched, error: null };
		}
		return { project: null, error: "Project not found" };
	}

	const stored = localStorage.getItem(STORAGE_KEY);
	const resolved =
		(stored && (projects.find((p) => p.id === stored) ?? null)) || projects[0] || null;
	if (resolved) persistProjectId(resolved.id);
	return { project: resolved, error: null };
}

export async function resolveProjectId<T extends ProjectIdCandidate>(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches?: (project: T, hint: string) => boolean
): Promise<ResolveProjectIdResult<T>> {
	let projects: T[];
	try {
		projects = await fetchProjects<T>(workspaceSlug);
	} catch {
		return { project: null, projects: [], error: "Failed to load projects" };
	}

	const { project, error } = matchProjectId(projects, urlHint, matches);
	return { project, projects, error };
}
