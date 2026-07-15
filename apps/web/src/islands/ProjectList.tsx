import { useEffect, useRef, useState } from "preact/hooks";
import { useAccessGate } from "../utils/access-gate";
import { apiFetch } from "../utils/api-client";
import AccessPending from "./AccessPending";

interface Project {
	id: string;
	name: string;
	key: string;
	slug: string | null;
	description: string | null;
	workspace_id: string;
	workspace_name: string;
	workspace_slug: string;
	open_issue_count: number;
	created_at: number;
	updated_at: number;
}

function deriveKey(name: string): string {
	return name
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 10);
}

const INPUT_BASE_CLASS =
	"w-full px-2 py-1.5 text-sm border border-[var(--border)] rounded bg-[var(--bg)] text-[var(--text)]";

const PROJECT_CARD_CLASS =
	"flex flex-col gap-2 p-4 bg-[var(--surface)] border border-[var(--border)] rounded-lg no-underline shadow-sm" +
	" transition-all duration-150 hover:border-[var(--accent)] hover:-translate-y-px";

const KEY_BADGE_CLASS =
	"font-mono text-[0.7rem] font-medium px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)]" +
	" text-[var(--text-muted)] leading-6";

interface ProjectCreateFormProps {
	nameRef: { current: HTMLInputElement | null };
	formName: string;
	onNameInput: (v: string) => void;
	formKey: string;
	onKeyInput: (v: string) => void;
	formDesc: string;
	onDescInput: (v: string) => void;
	formError: string | null;
	submitting: boolean;
	onSubmit: (e: Event) => void;
	onCancel: () => void;
}

function ProjectCreateForm({
	nameRef,
	formName,
	onNameInput,
	formKey,
	onKeyInput,
	formDesc,
	onDescInput,
	formError,
	submitting,
	onSubmit,
	onCancel,
}: ProjectCreateFormProps) {
	return (
		<form
			onSubmit={onSubmit}
			class="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 mb-5 flex flex-col gap-3"
		>
			<div class="flex gap-3 flex-wrap">
				<div class="flex-[2_1_160px] min-w-0">
					<label
						htmlFor="new-project-name"
						class="block mb-1 text-xs font-semibold text-[var(--text-muted)]"
					>
						Name{" "}
						<span aria-hidden="true" style={{ color: "var(--accent)" }}>
							*
						</span>
					</label>
					<input
						ref={nameRef}
						id="new-project-name"
						type="text"
						required
						maxLength={100}
						placeholder="My Project"
						value={formName}
						onInput={(e) => onNameInput((e.target as HTMLInputElement).value)}
						class={INPUT_BASE_CLASS}
					/>
				</div>
				<div class="flex-[1_1_100px] min-w-0">
					<label
						htmlFor="new-project-key"
						class="block mb-1 text-xs font-semibold text-[var(--text-muted)]"
					>
						Key{" "}
						<span aria-hidden="true" style={{ color: "var(--accent)" }}>
							*
						</span>
					</label>
					<input
						id="new-project-key"
						type="text"
						required
						maxLength={10}
						placeholder="MYPROJ"
						value={formKey}
						onInput={(e) => onKeyInput((e.target as HTMLInputElement).value.toUpperCase())}
						class={`${INPUT_BASE_CLASS} font-mono uppercase`}
					/>
				</div>
				<div class="flex-[3_1_220px] min-w-0">
					<label
						htmlFor="new-project-desc"
						class="block mb-1 text-xs font-semibold text-[var(--text-muted)]"
					>
						Description
					</label>
					<input
						id="new-project-desc"
						type="text"
						maxLength={500}
						placeholder="Optional description"
						value={formDesc}
						onInput={(e) => onDescInput((e.target as HTMLInputElement).value)}
						class={INPUT_BASE_CLASS}
					/>
				</div>
			</div>

			{formError && (
				<p role="alert" class="m-0 text-xs text-red-600">
					{formError}
				</p>
			)}

			<div class="flex gap-2 justify-end">
				<button
					type="button"
					onClick={onCancel}
					disabled={submitting}
					class="btn btn-outline btn-sm"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={submitting}
					class="btn btn-primary btn-sm"
					style={{ opacity: submitting ? 0.6 : 1 }}
				>
					{submitting ? "Creating…" : "Create project"}
				</button>
			</div>
		</form>
	);
}

function useProjectCreateForm(workspaceSlug: string | undefined, onCreated: (p: Project) => void) {
	const [formOpen, setFormOpen] = useState(false);
	const [formName, setFormName] = useState("");
	const [formKey, setFormKey] = useState("");
	const [formKeyTouched, setFormKeyTouched] = useState(false);
	const [formDesc, setFormDesc] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	// Auto-derive key from name unless the user has manually edited it
	useEffect(() => {
		if (!formKeyTouched) {
			setFormKey(deriveKey(formName));
		}
	}, [formName, formKeyTouched]);

	function open() {
		setFormName("");
		setFormKey("");
		setFormKeyTouched(false);
		setFormDesc("");
		setFormError(null);
		setFormOpen(true);
		// Focus the name input on next tick
		setTimeout(() => nameRef.current?.focus(), 0);
	}

	function close() {
		setFormOpen(false);
		setFormError(null);
	}

	function handleKeyInput(v: string) {
		setFormKey(v.toUpperCase());
		setFormKeyTouched(true);
	}

	async function submit(e: Event) {
		e.preventDefault();
		if (submitting) return;

		const name = formName.trim();
		const key = formKey.trim().toUpperCase();
		const description = formDesc.trim() || undefined;

		if (!name) {
			setFormError("Name is required.");
			return;
		}
		if (!key || !/^[A-Z0-9]+$/.test(key) || key.length > 10) {
			setFormError("Key must be 1–10 alphanumeric characters.");
			return;
		}

		setFormError(null);
		setSubmitting(true);

		try {
			const created = await apiFetch<{ id: string; name: string; key: string; slug: string }>(
				"/api/projects",
				{
					method: "POST",
					workspaceSlug,
					body: { name, key, description },
				}
			);

			onCreated({
				id: created.id,
				name: created.name,
				key: created.key,
				slug: created.slug,
				description: description ?? null,
				workspace_id: "",
				workspace_name: "",
				workspace_slug: workspaceSlug ?? "",
				open_issue_count: 0,
				created_at: Math.floor(Date.now() / 1000),
				updated_at: Math.floor(Date.now() / 1000),
			});
			close();
		} catch (err) {
			setFormError(String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return {
		formOpen,
		formName,
		setFormName,
		formKey,
		formDesc,
		setFormDesc,
		submitting,
		formError,
		nameRef,
		open,
		close,
		handleKeyInput,
		submit,
	};
}

function ProjectCard({ project }: { project: Project }) {
	const count = project.open_issue_count ?? 0;
	const countLabel =
		count === 0 ? "No open issues" : `${count} open issue${count !== 1 ? "s" : ""}`;

	return (
		<a
			href={
				project.slug
					? `/projects/view/${encodeURIComponent(project.slug)}`
					: `/projects/view?id=${project.id}`
			}
			class={PROJECT_CARD_CLASS}
		>
			<div class="flex items-center gap-2">
				<span class="font-bold text-[var(--text)] text-base">{project.name}</span>
				<span class={KEY_BADGE_CLASS}>{project.key}</span>
			</div>
			<span class="text-xs text-[var(--text-muted)]">{countLabel}</span>
			{project.description && (
				<span
					class="text-sm text-[var(--text-muted)] overflow-hidden"
					style={{
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
					}}
				>
					{project.description}
				</span>
			)}
		</a>
	);
}

function ProjectGrid({ projects }: { projects: Project[] }) {
	if (projects.length === 0) {
		return <p class="text-[var(--text-muted)] text-center py-12">No projects yet.</p>;
	}
	return (
		<div
			class="grid gap-4"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
		>
			{projects.map((p) => (
				<ProjectCard key={p.id} project={p} />
			))}
		</div>
	);
}

export default function ProjectList({ workspaceSlug }: { workspaceSlug?: string }) {
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		setError(null);

		apiFetch<Project[]>("/api/projects", { workspaceSlug })
			.then((data) => setProjects(Array.isArray(data) ? data : []))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [workspaceSlug]);

	const gate = useAccessGate(workspaceSlug);

	const createForm = useProjectCreateForm(workspaceSlug, (p) =>
		setProjects((prev) => [...prev, p])
	);

	if (gate.pending) return <AccessPending />;
	if (loading) return <p aria-live="polite">Loading projects…</p>;
	if (error)
		return (
			<p role="alert" class="text-red-600">
				Failed to load projects: {error}
			</p>
		);

	return (
		<>
			<div class="flex justify-end mb-4">
				{!createForm.formOpen && (
					<button type="button" onClick={createForm.open} class="btn btn-primary btn-sm">
						+ New project
					</button>
				)}
			</div>

			{createForm.formOpen && (
				<ProjectCreateForm
					nameRef={createForm.nameRef}
					formName={createForm.formName}
					onNameInput={createForm.setFormName}
					formKey={createForm.formKey}
					onKeyInput={createForm.handleKeyInput}
					formDesc={createForm.formDesc}
					onDescInput={createForm.setFormDesc}
					formError={createForm.formError}
					submitting={createForm.submitting}
					onSubmit={createForm.submit}
					onCancel={createForm.close}
				/>
			)}

			<ProjectGrid projects={projects} />
		</>
	);
}
