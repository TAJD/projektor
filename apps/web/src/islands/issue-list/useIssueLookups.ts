import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import type { Issue, TaskStatus } from "../board-utils";
import type { SprintDetail } from "./SprintBannerSection";
import type { ProjectMeta } from "./types";

/**
 * Owns the active project's sprints and the active sprint's detail (for the
 * sprint banner + selector), separated from the other lookups so each hook
 * stays a manageable size.
 */
function useSprintLookups(
	workspaceSlug: string | undefined,
	filterProject: string,
	filterSprintId: string
) {
	const [sprints, setSprints] = useState<Array<{ id: string; name: string; status: string }>>([]);
	const [sprintDetail, setSprintDetail] = useState<SprintDetail | null>(null);

	// Fetch project's sprints when project filter is active, or when a sprintId is set
	// (so the sprint selector appears even when navigating directly to a ?sprintId= URL).
	useEffect(() => {
		const fallbackProjectId = !filterProject && sprintDetail ? sprintDetail.projectId : null;
		if (!filterProject && !fallbackProjectId) {
			setSprints([]);
			return;
		}
		(async () => {
			try {
				let projectId: string;
				if (fallbackProjectId) {
					projectId = fallbackProjectId;
				} else {
					const allProjects = await apiFetch<Array<{ id: string; key: string }>>("/api/projects", {
						workspaceSlug,
					});
					const proj = allProjects.find((p) => p.key === filterProject);
					if (!proj) return;
					projectId = proj.id;
				}
				const data = await apiFetch<{ items: Array<{ id: string; name: string; status: string }> }>(
					`/api/sprints?projectId=${encodeURIComponent(projectId)}`,
					{ workspaceSlug }
				);
				setSprints(Array.isArray(data?.items) ? data.items : []);
			} catch {
				// non-fatal
			}
		})();
	}, [filterProject, sprintDetail, workspaceSlug]);

	// Fetch sprint details when a sprintId filter is active, for the sprint banner.
	useEffect(() => {
		if (!filterSprintId) {
			setSprintDetail(null);
			return;
		}
		(async () => {
			try {
				const data = await apiFetch<SprintDetail>(`/api/sprints/${filterSprintId}`, {
					workspaceSlug,
				});
				setSprintDetail(data);
			} catch {
				// non-fatal
			}
		})();
	}, [filterSprintId, workspaceSlug]);

	return { sprints, setSprints, sprintDetail, setSprintDetail };
}

/**
 * Owns the lookup lists behind the issue list: statuses, projects, task types,
 * the epic dropdown, the active project's sprints, and the active sprint's detail.
 */
export function useIssueLookups(
	workspaceSlug: string | undefined,
	filterProject: string,
	filterSprintId: string
) {
	const [statuses, setStatuses] = useState<TaskStatus[]>([]);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);
	const [taskTypes, setTaskTypes] = useState<Array<{ id: string; key: string; name: string }>>([]);
	// Epics for the epic filter dropdown — fetched independently of the paginated
	// list (PROJ-211) so the dropdown is complete and survives "Hide epics", which
	// now excludes epic-typed issues from the list server-side.
	const [epics, setEpics] = useState<Issue[]>([]);
	const { sprints, setSprints, sprintDetail, setSprintDetail } = useSprintLookups(
		workspaceSlug,
		filterProject,
		filterSprintId
	);

	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<TaskStatus[]>("/api/task-statuses", { workspaceSlug });
				if (Array.isArray(data)) setStatuses(data);
			} catch {
				// non-fatal — status filter will derive from issue data
			}
		})();
	}, [workspaceSlug]);

	// Fetch task types for the create modal type selector (PROJ-157)
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<Array<{ id: string; key: string; name: string }>>(
					"/api/task-types",
					{
						workspaceSlug,
					}
				);
				if (Array.isArray(data)) setTaskTypes(data);
			} catch {
				// non-fatal
			}
		})();
	}, [workspaceSlug]);

	// Fetch project list for create modal + description lookup
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<ProjectMeta[]>("/api/projects", { workspaceSlug });
				if (Array.isArray(data)) setProjects(data);
			} catch {
				// non-fatal
			}
		})();
	}, [workspaceSlug]);

	// Fetch epics for the epic filter dropdown, independent of the paginated list
	// (PROJ-211). Scoped to the active project filter when set. Keyed on the
	// derived ids, not the lookup-array identities — a fresh projects/taskTypes
	// array that resolves to the same ids must not refire this fetch.
	const epicTypeId = taskTypes.find((t) => t.key === "epic")?.id;
	const epicProjectId = filterProject
		? projects.find((p) => p.key === filterProject)?.id
		: undefined;
	useEffect(() => {
		if (!epicTypeId) {
			setEpics([]);
			return;
		}
		(async () => {
			try {
				const qs = new URLSearchParams({ typeId: epicTypeId, limit: "100" });
				if (epicProjectId) qs.set("project", epicProjectId);
				const data = await apiFetch<{ items: Issue[] }>(`/api/issues?${qs.toString()}`, {
					workspaceSlug,
				});
				setEpics(Array.isArray(data.items) ? data.items : []);
			} catch {
				// non-fatal — epic dropdown just won't populate
			}
		})();
	}, [workspaceSlug, epicTypeId, epicProjectId]);

	return {
		statuses,
		projects,
		taskTypes,
		epics,
		sprints,
		sprintDetail,
		setSprintDetail,
		setSprints,
	};
}
