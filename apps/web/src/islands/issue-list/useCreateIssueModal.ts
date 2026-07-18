import type { Dispatch, StateUpdater } from "preact/hooks";
import { useEffect, useState } from "preact/hooks";
import { ApiOfflineError, apiFetch } from "../../utils/api-client";
import type { Issue, TaskStatus } from "../board-utils";
import { buildCreateIssuePayload, buildOptimisticIssue } from "../IssueList-helpers";
import type { ProjectMeta } from "./types";

interface Params {
	workspaceSlug?: string;
	filterProject: string;
	projects: ProjectMeta[];
	statuses: TaskStatus[];
	taskTypes: Array<{ id: string; key: string; name: string }>;
	setIssues: Dispatch<StateUpdater<Issue[]>>;
}

/** Owns the "New issue" modal's form state and submit flow, isolated from the parent list. */
export function useCreateIssueModal({
	workspaceSlug,
	filterProject,
	projects,
	statuses,
	taskTypes,
	setIssues,
}: Params) {
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createBody, setCreateBody] = useState("");
	const [createPriority, setCreatePriority] = useState("medium");
	const [createStatusId, setCreateStatusId] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [createTypeId, setCreateTypeId] = useState("");
	const [submittingCreate, setSubmittingCreate] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	// Escape closes the create modal
	useEffect(() => {
		if (!showCreateModal) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setShowCreateModal(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [showCreateModal]);

	function openCreateModal() {
		const targetProjectId = filterProject
			? (projects.find((p) => p.key === filterProject)?.id ?? projects[0]?.id ?? "")
			: (projects[0]?.id ?? "");
		setCreateProjectId(targetProjectId);
		setCreateTitle("");
		setCreateBody("");
		setCreatePriority("medium");
		setCreateStatusId("");
		setCreateTypeId("");
		setCreateError(null);
		setShowCreateModal(true);
	}

	async function submitCreate(e: Event) {
		e.preventDefault();
		if (!createTitle.trim() || !createProjectId) return;
		setSubmittingCreate(true);
		setCreateError(null);
		const createInput = {
			createProjectId,
			createTitle,
			createBody,
			createPriority,
			createStatusId,
			createTypeId,
		};
		try {
			const created = await apiFetch<{ id: string; number: number }>("/api/issues", {
				method: "POST",
				workspaceSlug,
				body: buildCreateIssuePayload(createInput),
			});

			const newIssue = buildOptimisticIssue(created, createInput, {
				projects,
				statuses,
				taskTypes,
			});
			setIssues((prev) => [newIssue, ...prev]);
			setShowCreateModal(false);
		} catch (err) {
			setCreateError(
				err instanceof ApiOfflineError
					? "You're offline — the issue wasn't created. Try again once your connection returns."
					: `Failed to create issue: ${String(err)}`
			);
		} finally {
			setSubmittingCreate(false);
		}
	}

	return {
		showCreateModal,
		setShowCreateModal,
		createTitle,
		setCreateTitle,
		createBody,
		setCreateBody,
		createPriority,
		setCreatePriority,
		createStatusId,
		setCreateStatusId,
		createProjectId,
		setCreateProjectId,
		createTypeId,
		setCreateTypeId,
		submittingCreate,
		createError,
		openCreateModal,
		submitCreate,
	};
}
