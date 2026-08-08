import type { Dispatch, StateUpdater } from "preact/hooks";
import { PRIORITY_OPTIONS } from "../../utils/issue-utils";
import type { TaskStatus } from "../board-utils";
import MarkdownEditor from "../LazyMarkdownEditor";
import { Button } from "../ui/Button";
import Select from "../ui/Select";
import type { ProjectMeta } from "./types";

interface CreateIssueModalProps {
	createTitle: string;
	setCreateTitle: Dispatch<StateUpdater<string>>;
	createBody: string;
	setCreateBody: Dispatch<StateUpdater<string>>;
	createPriority: string;
	setCreatePriority: Dispatch<StateUpdater<string>>;
	createProjectId: string;
	setCreateProjectId: Dispatch<StateUpdater<string>>;
	createTypeId: string;
	setCreateTypeId: Dispatch<StateUpdater<string>>;
	createStatusId: string;
	setCreateStatusId: Dispatch<StateUpdater<string>>;
	createError: string | null;
	submittingCreate: boolean;
	submitCreate: (e: Event) => void;
	setShowCreateModal: Dispatch<StateUpdater<boolean>>;
	projects: ProjectMeta[];
	taskTypes: Array<{ id: string; key: string; name: string }>;
	statuses: TaskStatus[];
}

function CreateIssueModalFields({
	createPriority,
	setCreatePriority,
	createProjectId,
	setCreateProjectId,
	createTypeId,
	setCreateTypeId,
	createStatusId,
	setCreateStatusId,
	projects,
	taskTypes,
	statuses,
}: Omit<
	CreateIssueModalProps,
	| "createTitle"
	| "setCreateTitle"
	| "createBody"
	| "setCreateBody"
	| "createError"
	| "submittingCreate"
	| "submitCreate"
	| "setShowCreateModal"
>) {
	return (
		<div class="flex gap-3 mb-5 flex-wrap items-end">
			{projects.length > 1 && (
				<div>
					<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
						Project
						<Select
							ariaLabel="Select project"
							value={createProjectId}
							onChange={setCreateProjectId}
							options={projects.map((p) => ({ value: p.id, label: p.name }))}
						/>
					</label>
				</div>
			)}

			<div>
				<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
					Priority
					<Select
						ariaLabel="Select priority"
						value={createPriority}
						onChange={setCreatePriority}
						capitalize
						options={PRIORITY_OPTIONS}
						buttonStyle={{
							background: `var(--priority-${createPriority}-bg, var(--priority-low-bg))`,
							color: `var(--priority-${createPriority}-text, var(--text-muted))`,
							fontWeight: 500,
							borderColor: "transparent",
						}}
					/>
				</label>
			</div>

			{taskTypes.length > 0 && (
				<div>
					<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
						Type
						<Select
							ariaLabel="Select type"
							value={createTypeId}
							onChange={setCreateTypeId}
							options={[
								{ value: "", label: "No type" },
								...taskTypes.map((t) => ({ value: t.id, label: t.name })),
							]}
						/>
					</label>
				</div>
			)}

			{statuses.length > 0 && (
				<div>
					<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
						Status
						<Select
							ariaLabel="Select status"
							value={createStatusId}
							onChange={setCreateStatusId}
							options={[
								{ value: "", label: "Default" },
								...statuses.map((s) => ({ value: s.id, label: s.name })),
							]}
						/>
					</label>
				</div>
			)}
		</div>
	);
}

export default function CreateIssueModal(props: CreateIssueModalProps) {
	const {
		createTitle,
		setCreateTitle,
		createBody,
		setCreateBody,
		createError,
		submittingCreate,
		submitCreate,
		setShowCreateModal,
		createProjectId,
	} = props;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape handles keyboard
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<div
			class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
			onClick={(e) => {
				if (e.target === e.currentTarget) setShowCreateModal(false);
			}}
		>
			<div
				class={[
					"bg-bg border border-border rounded-lg p-6 w-full max-w-[660px] max-h-[80vh] overflow-y-auto mx-4",
					"max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:max-h-[90vh] max-sm:mx-0",
				].join(" ")}
				role="dialog"
				aria-modal="true"
				aria-label="Create new issue"
			>
				<h2 class="mb-5 text-lg font-bold text-text-base">New issue</h2>

				{createError && (
					<p role="alert" class="text-[var(--danger-text)] mb-3 text-sm">
						{createError}
					</p>
				)}

				<form onSubmit={submitCreate}>
					<div class="mb-[0.875rem]">
						<label class="block text-[0.78rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
							Title *
							<input
								type="text"
								value={createTitle}
								onInput={(e) => setCreateTitle((e.target as HTMLInputElement).value)}
								placeholder="Issue title"
								required
								// biome-ignore lint/a11y/noAutofocus: intentional — modal opens on user action
								autoFocus
								class={[
									"w-full px-3 py-2 border border-border rounded bg-bg text-text-base box-border text-[0.9rem]",
									"font-normal normal-case tracking-normal mt-[0.3rem]",
								].join(" ")}
							/>
						</label>
					</div>

					<div class="mb-[0.875rem]">
						{/* PROJ-566: a caption sibling, NOT a wrapper. A <label> with no `for` forwards
						    clicks on its non-interactive descendants to its first labelable control —
						    here the editor toolbar's Bold button — so every tap in the editor body ran
						    Bold. The editor names itself via ariaLabel instead. */}
						{/* biome-ignore lint/a11y/noLabelWithoutControl: caption for MarkdownEditor, which has no associable control */}
						<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
							Description
						</label>
						<MarkdownEditor
							value={createBody}
							onChange={setCreateBody}
							minHeight="160px"
							ariaLabel="Description"
						/>
					</div>

					<CreateIssueModalFields {...props} />

					<div class="flex gap-2">
						<Button
							type="submit"
							variant="primary"
							disabled={submittingCreate || !createTitle.trim() || !createProjectId}
						>
							{submittingCreate ? "Creating…" : "Create issue"}
						</Button>
						<Button type="button" variant="outline" onClick={() => setShowCreateModal(false)}>
							Cancel
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
