import type { Dispatch, StateUpdater } from "preact/hooks";
import { useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import type { Issue, TaskStatus } from "../board-utils";

/** Owns the status/priority PATCH flows shared by the board, backlog, and list views. */
export function useIssueMutations(
	workspaceSlug: string | undefined,
	statuses: TaskStatus[],
	setIssues: Dispatch<StateUpdater<Issue[]>>,
	fetchIssues: () => Promise<void>
) {
	const [updatingId, setUpdatingId] = useState<string | null>(null);
	const [updatingPriorityId, setUpdatingPriorityId] = useState<string | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);

	async function changeStatus(issueId: string, statusId: string) {
		const status = statuses.find((s) => s.id === statusId);
		if (!status) return;

		setUpdateError(null);
		setIssues((prev) =>
			prev.map((i) =>
				i.id === issueId
					? {
						...i,
						status_id: status.id,
						status_key: status.key,
						status_name: status.name,
						status_category: status.category,
					}
					: i
			)
		);

		setUpdatingId(issueId);
		try {
			await apiFetch(`/api/issues/${issueId}`, { method: "PATCH", workspaceSlug, body: { statusId } });
		} catch (e) {
			setUpdateError(`Status update failed: ${String(e)}`);
			// Revert by refetching authoritative data
			await fetchIssues();
		} finally {
			setUpdatingId(null);
		}
	}

	async function changePriority(issueId: string, priority: string) {
		setUpdateError(null);
		setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, priority } : i)));

		setUpdatingPriorityId(issueId);
		try {
			await apiFetch(`/api/issues/${issueId}`, { method: "PATCH", workspaceSlug, body: { priority } });
		} catch (e) {
			setUpdateError(`Priority update failed: ${String(e)}`);
			await fetchIssues();
		} finally {
			setUpdatingPriorityId(null);
		}
	}

	return { updatingId, updatingPriorityId, updateError, changeStatus, changePriority };
}
