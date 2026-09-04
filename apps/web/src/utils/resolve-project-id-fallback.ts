import { apiFetch } from "./api-client";

interface ProjectSummary {
	id: string;
}

export async function resolveProjectIdFallback(
	workspaceSlug: string | undefined
): Promise<string | null> {
	const params = new URLSearchParams(window.location.search);
	const fromUrl = params.get("projectId") || params.get("id");
	if (fromUrl) return fromUrl;

	const stored = localStorage.getItem("projektor-last-project-id");
	if (stored) return stored;

	try {
		const list = await apiFetch<ProjectSummary[]>("/api/projects", { workspaceSlug });
		return Array.isArray(list) && list.length > 0 ? list[0].id : null;
	} catch {
		return null;
	}
}
