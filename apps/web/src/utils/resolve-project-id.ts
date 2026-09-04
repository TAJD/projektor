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

export async function resolveProjectId<T extends ProjectIdCandidate>(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches: (project: T, hint: string) => boolean = (p, hint) => p.id === hint
): Promise<ResolveProjectIdResult<T>> {
	let projects: T[];
	try {
		const list = await apiFetch<T[]>("/api/projects", { workspaceSlug });
		projects = Array.isArray(list) ? list : [];
	} catch {
		return { project: null, projects: [], error: "Failed to load projects" };
	}

	if (urlHint) {
		const matched = projects.find((p) => matches(p, urlHint)) ?? null;
		if (matched) {
			persistProjectId(matched.id);
			return { project: matched, projects, error: null };
		}
		return { project: null, projects, error: "Project not found" };
	}

	const stored = localStorage.getItem(STORAGE_KEY);
	const resolved =
		(stored && (projects.find((p) => p.id === stored) ?? null)) || projects[0] || null;
	if (resolved) persistProjectId(resolved.id);
	return { project: resolved, projects, error: null };
}
