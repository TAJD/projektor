import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
	fetchProjects,
	matchProjectId,
	type ProjectIdCandidate,
	readUrlProjectId,
} from "../utils/resolve-project-id";

export interface ProjectSummary extends ProjectIdCandidate {
	key: string;
	name: string;
	slug: string | null;
}

export const currentProject = signal<ProjectSummary | null>(null);
export const projectsList = signal<ProjectSummary[]>([]);
export const projectError = signal<string | null>(null);
export const projectReady = signal(false);

let projectsPromise: Promise<ProjectSummary[]> | null = null;

function loadProjects(workspaceSlug: string | undefined): Promise<ProjectSummary[]> {
	if (projectsList.value.length > 0) return Promise.resolve(projectsList.value);
	if (!projectsPromise) {
		projectsPromise = fetchProjects<ProjectSummary>(workspaceSlug).catch(() => {
			projectsPromise = null;
			throw new Error("Failed to load projects");
		});
	}
	return projectsPromise;
}

export async function ensureProjectResolved(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches?: (project: ProjectSummary, hint: string) => boolean
): Promise<void> {
	if (!urlHint && currentProject.value) {
		projectReady.value = true;
		return;
	}

	try {
		const projects = await loadProjects(workspaceSlug);
		projectsList.value = projects;
		const { project, error } = matchProjectId(projects, urlHint, matches);
		currentProject.value = project;
		projectError.value = error;
	} catch {
		projectError.value = "Failed to load projects";
	}
	projectReady.value = true;
}

export function __resetProjectStoreForTests(): void {
	currentProject.value = null;
	projectsList.value = [];
	projectError.value = null;
	projectReady.value = false;
	projectsPromise = null;
}

export function useCurrentProject(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches?: (project: ProjectSummary, hint: string) => boolean
) {
	useEffect(() => {
		ensureProjectResolved(workspaceSlug, urlHint, matches);
	}, [workspaceSlug, urlHint]);

	return {
		project: currentProject.value,
		projects: projectsList.value,
		error: projectError.value,
		ready: projectReady.value,
	};
}
