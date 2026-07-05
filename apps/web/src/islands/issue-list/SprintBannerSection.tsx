import type { Dispatch, StateUpdater } from "preact/hooks";
import { useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import type { Issue } from "../board-utils";

export interface SprintDetail {
	id: string;
	name: string;
	status: "planned" | "active" | "completed";
	startDate: number | null;
	endDate: number | null;
	goal: string | null;
	projectId: string;
}

function tsToDateInput(ts: number): string {
	const d = new Date(ts * 1000);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function sprintStatusStyle(status: SprintDetail["status"]): {
	background: string;
	color: string;
	borderColor: string;
} {
	if (status === "active") {
		return { background: "rgba(37,99,235,0.12)", color: "var(--status-in-progress)", borderColor: "rgba(37,99,235,0.3)" };
	}
	if (status === "completed") {
		return { background: "rgba(22,163,74,0.12)", color: "var(--status-done)", borderColor: "rgba(22,163,74,0.3)" };
	}
	return { background: "var(--surface)", color: "var(--text-muted)", borderColor: "var(--border)" };
}

function SprintProgress({ issues }: { issues: Issue[] }) {
	const doneCount = issues.filter((i) => i.status_category === "done").length;
	const totalCount = issues.length;
	if (totalCount === 0) return null;
	const pct = Math.round((doneCount / totalCount) * 100);
	return (
		<div class="mt-2">
			<div class="flex justify-between text-[0.72rem] text-text-muted mb-1">
				<span>
					{doneCount}/{totalCount} done
				</span>
				<span>{pct}%</span>
			</div>
			<div class="h-1.5 bg-bg rounded-full overflow-hidden border border-border">
				<div
					class="h-full rounded-full transition-[width] duration-300"
					style={{ width: `${pct}%`, background: "var(--accent)" }}
				/>
			</div>
		</div>
	);
}

interface SprintBannerProps {
	sprintDetail: SprintDetail;
	sprintEditing: boolean;
	setSprintEditing: Dispatch<StateUpdater<boolean>>;
	sprintEditName: string;
	setSprintEditName: Dispatch<StateUpdater<string>>;
	sprintEditGoal: string;
	setSprintEditGoal: Dispatch<StateUpdater<string>>;
	sprintEditStatus: "planned" | "active" | "completed";
	setSprintEditStatus: Dispatch<StateUpdater<"planned" | "active" | "completed">>;
	sprintEditStart: string;
	setSprintEditStart: Dispatch<StateUpdater<string>>;
	sprintEditEnd: string;
	setSprintEditEnd: Dispatch<StateUpdater<string>>;
	sprintEditSaving: boolean;
	sprintEditError: string | null;
	saveSprintEdit: (e: Event) => void;
	openSprintEdit: () => void;
	setFilterSprintId: Dispatch<StateUpdater<string>>;
	issues: Issue[];
}

const SPRINT_EDIT_INPUT_CLASS = [
	"px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base",
	"font-normal normal-case tracking-normal mt-[0.2rem]",
].join(" ");

function SprintEditFields({
	sprintEditName,
	setSprintEditName,
	sprintEditStatus,
	setSprintEditStatus,
	sprintEditStart,
	setSprintEditStart,
	sprintEditEnd,
	setSprintEditEnd,
}: Pick<
	SprintBannerProps,
	| "sprintEditName"
	| "setSprintEditName"
	| "sprintEditStatus"
	| "setSprintEditStatus"
	| "sprintEditStart"
	| "setSprintEditStart"
	| "sprintEditEnd"
	| "setSprintEditEnd"
>) {
	return (
		<div class="flex gap-3 flex-wrap items-end">
			<div class="flex-1 min-w-[160px]">
				<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
					Name *
					<input
						type="text"
						value={sprintEditName}
						onInput={(e) => setSprintEditName((e.target as HTMLInputElement).value)}
						required
						maxLength={255}
						class={`w-full ${SPRINT_EDIT_INPUT_CLASS}`}
					/>
				</label>
			</div>
			<div>
				<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
					Status
					<select
						value={sprintEditStatus}
						onChange={(e) =>
							setSprintEditStatus((e.target as HTMLSelectElement).value as "planned" | "active" | "completed")
						}
						class={`cursor-pointer ${SPRINT_EDIT_INPUT_CLASS}`}
					>
						<option value="planned">Planned</option>
						<option value="active">Active</option>
						<option value="completed">Completed</option>
					</select>
				</label>
			</div>
			<div>
				<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
					Start date
					<input
						type="date"
						value={sprintEditStart}
						onInput={(e) => setSprintEditStart((e.target as HTMLInputElement).value)}
						class={SPRINT_EDIT_INPUT_CLASS}
					/>
				</label>
			</div>
			<div>
				<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
					End date
					<input
						type="date"
						value={sprintEditEnd}
						onInput={(e) => setSprintEditEnd((e.target as HTMLInputElement).value)}
						class={SPRINT_EDIT_INPUT_CLASS}
					/>
				</label>
			</div>
		</div>
	);
}

function SprintEditForm({
	sprintEditName,
	setSprintEditName,
	sprintEditGoal,
	setSprintEditGoal,
	sprintEditStatus,
	setSprintEditStatus,
	sprintEditStart,
	setSprintEditStart,
	sprintEditEnd,
	setSprintEditEnd,
	sprintEditSaving,
	sprintEditError,
	saveSprintEdit,
	setSprintEditing,
}: Omit<SprintBannerProps, "sprintDetail" | "openSprintEdit" | "setFilterSprintId" | "issues" | "sprintEditing">) {
	return (
		<form onSubmit={saveSprintEdit}>
			{sprintEditError && (
				<p role="alert" class="text-[var(--danger-text)] text-sm mb-2">
					{sprintEditError}
				</p>
			)}
			<div class="flex flex-col gap-3">
				<SprintEditFields
					sprintEditName={sprintEditName}
					setSprintEditName={setSprintEditName}
					sprintEditStatus={sprintEditStatus}
					setSprintEditStatus={setSprintEditStatus}
					sprintEditStart={sprintEditStart}
					setSprintEditStart={setSprintEditStart}
					sprintEditEnd={sprintEditEnd}
					setSprintEditEnd={setSprintEditEnd}
				/>
				<div>
					<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
						Goal
						<input
							type="text"
							value={sprintEditGoal}
							onInput={(e) => setSprintEditGoal((e.target as HTMLInputElement).value)}
							maxLength={2000}
							placeholder="What do you want to achieve this sprint?"
							class={`w-full ${SPRINT_EDIT_INPUT_CLASS}`}
						/>
					</label>
				</div>
				<div class="flex gap-2">
					<button
						type="submit"
						disabled={sprintEditSaving || !sprintEditName.trim()}
						class="btn btn-primary btn-sm"
					>
						{sprintEditSaving ? "Saving…" : "Save"}
					</button>
					<button type="button" onClick={() => setSprintEditing(false)} class="btn btn-outline btn-sm">
						Cancel
					</button>
				</div>
			</div>
		</form>
	);
}

function SprintBannerView({
	sprintDetail,
	openSprintEdit,
	setFilterSprintId,
	issues,
}: Pick<SprintBannerProps, "sprintDetail" | "openSprintEdit" | "setFilterSprintId" | "issues">) {
	return (
		<>
			<div class="flex items-center gap-2 flex-wrap">
				<span class="font-semibold text-text-base">{sprintDetail.name}</span>
				<span
					class="text-[0.72rem] font-semibold px-2 py-0.5 rounded-full capitalize border"
					style={sprintStatusStyle(sprintDetail.status)}
				>
					{sprintDetail.status}
				</span>
				{sprintDetail.startDate && (
					<span class="text-sm text-text-muted">
						{new Date(sprintDetail.startDate * 1000).toLocaleDateString()}
						{" – "}
						{sprintDetail.endDate ? new Date(sprintDetail.endDate * 1000).toLocaleDateString() : "ongoing"}
					</span>
				)}
				<button
					type="button"
					onClick={openSprintEdit}
					class={[
						"py-[0.2rem] px-2 rounded border border-border bg-bg text-text-muted cursor-pointer",
						"text-[0.78rem] hover:text-text-base",
					].join(" ")}
				>
					Edit
				</button>
				<button
					type="button"
					onClick={() => setFilterSprintId("")}
					class="ml-auto py-[0.2rem] px-2 rounded border border-border bg-bg text-text-muted cursor-pointer text-[0.78rem]"
				>
					✕ Clear sprint
				</button>
			</div>
			{sprintDetail.goal && <p class="mt-1 text-sm text-text-muted m-0">{sprintDetail.goal}</p>}
			<SprintProgress issues={issues} />
		</>
	);
}

function SprintBanner(props: SprintBannerProps) {
	return (
		<div class="mb-4 px-[0.875rem] py-[0.625rem] bg-surface border border-border rounded-md">
			{props.sprintEditing ? <SprintEditForm {...props} /> : <SprintBannerView {...props} />}
		</div>
	);
}

interface SprintBannerSectionProps {
	filterSprintId: string;
	sprintDetail: SprintDetail | null;
	setSprintDetail: Dispatch<StateUpdater<SprintDetail | null>>;
	setSprints: Dispatch<StateUpdater<Array<{ id: string; name: string; status: string }>>>;
	setFilterSprintId: Dispatch<StateUpdater<string>>;
	workspaceSlug?: string;
	issues: Issue[];
}

/** Wraps SprintBanner with its own edit-form state, isolated from the parent list. */
export default function SprintBannerSection({
	filterSprintId,
	sprintDetail,
	setSprintDetail,
	setSprints,
	setFilterSprintId,
	workspaceSlug,
	issues,
}: SprintBannerSectionProps) {
	const [sprintEditing, setSprintEditing] = useState(false);
	const [sprintEditName, setSprintEditName] = useState("");
	const [sprintEditGoal, setSprintEditGoal] = useState("");
	const [sprintEditStatus, setSprintEditStatus] = useState<"planned" | "active" | "completed">("planned");
	const [sprintEditStart, setSprintEditStart] = useState("");
	const [sprintEditEnd, setSprintEditEnd] = useState("");
	const [sprintEditSaving, setSprintEditSaving] = useState(false);
	const [sprintEditError, setSprintEditError] = useState<string | null>(null);

	function openSprintEdit() {
		if (!sprintDetail) return;
		setSprintEditName(sprintDetail.name);
		setSprintEditGoal(sprintDetail.goal ?? "");
		setSprintEditStatus(sprintDetail.status);
		setSprintEditStart(sprintDetail.startDate ? tsToDateInput(sprintDetail.startDate) : "");
		setSprintEditEnd(sprintDetail.endDate ? tsToDateInput(sprintDetail.endDate) : "");
		setSprintEditError(null);
		setSprintEditing(true);
	}

	async function saveSprintEdit(e: Event) {
		e.preventDefault();
		if (!sprintDetail) return;
		setSprintEditSaving(true);
		setSprintEditError(null);
		try {
			const body: Record<string, unknown> = { name: sprintEditName.trim() };
			body.goal = sprintEditGoal.trim() || null;
			body.status = sprintEditStatus;
			body.startDate = sprintEditStart ? Math.floor(new Date(sprintEditStart).getTime() / 1000) : null;
			body.endDate = sprintEditEnd ? Math.floor(new Date(sprintEditEnd).getTime() / 1000) : null;
			await apiFetch(`/api/sprints/${sprintDetail.id}`, { method: "PATCH", workspaceSlug, body });
			const updated: SprintDetail = {
				...sprintDetail,
				name: sprintEditName.trim(),
				goal: sprintEditGoal.trim() || null,
				status: sprintEditStatus,
				startDate: sprintEditStart ? Math.floor(new Date(sprintEditStart).getTime() / 1000) : null,
				endDate: sprintEditEnd ? Math.floor(new Date(sprintEditEnd).getTime() / 1000) : null,
			};
			setSprintDetail(updated);
			setSprints((prev) =>
				prev.map((s) => (s.id === updated.id ? { ...s, name: updated.name, status: updated.status } : s))
			);
			setSprintEditing(false);
		} catch (err) {
			setSprintEditError(String(err));
		} finally {
			setSprintEditSaving(false);
		}
	}

	if (!filterSprintId || !sprintDetail) return null;

	return (
		<SprintBanner
			sprintDetail={sprintDetail}
			sprintEditing={sprintEditing}
			setSprintEditing={setSprintEditing}
			sprintEditName={sprintEditName}
			setSprintEditName={setSprintEditName}
			sprintEditGoal={sprintEditGoal}
			setSprintEditGoal={setSprintEditGoal}
			sprintEditStatus={sprintEditStatus}
			setSprintEditStatus={setSprintEditStatus}
			sprintEditStart={sprintEditStart}
			setSprintEditStart={setSprintEditStart}
			sprintEditEnd={sprintEditEnd}
			setSprintEditEnd={setSprintEditEnd}
			sprintEditSaving={sprintEditSaving}
			sprintEditError={sprintEditError}
			saveSprintEdit={saveSprintEdit}
			openSprintEdit={openSprintEdit}
			setFilterSprintId={setFilterSprintId}
			issues={issues}
		/>
	);
}
