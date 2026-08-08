import { useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { Button } from "./ui/Button";

interface Props {
	projectId: string;
	workspaceSlug?: string;
	onClose: () => void;
	onCreated: () => void;
}

interface NewSourceResult {
	id: string;
	token: string;
}

function parseOrigins(raw: string): string[] | undefined {
	const list = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

const INPUT_CLASS =
	"w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";

function NewSourceForm({
	name,
	setName,
	description,
	setDescription,
	origins,
	setOrigins,
	creating,
	error,
	onSubmit,
	onCancel,
}: {
	name: string;
	setName: (v: string) => void;
	description: string;
	setDescription: (v: string) => void;
	origins: string;
	setOrigins: (v: string) => void;
	creating: boolean;
	error: string | null;
	onSubmit: (e: Event) => void;
	onCancel: () => void;
}) {
	return (
		<form onSubmit={onSubmit}>
			{error && (
				<p role="alert" class="text-[var(--danger-text)] mb-3 text-sm">
					{error}
				</p>
			)}
			<div class="mb-[0.875rem]">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="fs-name"
				>
					Name *
				</label>
				<input
					id="fs-name"
					class={INPUT_CLASS}
					value={name}
					onInput={(e) => setName((e.target as HTMLInputElement).value)}
					required
					maxLength={100}
					// biome-ignore lint/a11y/noAutofocus: intentional — modal opens on user action
					autoFocus
				/>
			</div>
			<div class="mb-[0.875rem]">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="fs-desc"
				>
					Description
				</label>
				<input
					id="fs-desc"
					class={INPUT_CLASS}
					value={description}
					onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
					maxLength={500}
				/>
			</div>
			<div class="mb-[0.875rem]">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="fs-origins"
				>
					Allowed origins (one per line, optional)
				</label>
				<textarea
					id="fs-origins"
					class={INPUT_CLASS}
					rows={2}
					value={origins}
					onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)}
				/>
			</div>
			<div class="flex gap-2">
				<Button type="submit" variant="primary" size="sm" disabled={creating || !name.trim()}>
					{creating ? "Creating…" : "Create source"}
				</Button>
				<Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={creating}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

export default function NewSourceModal({ projectId, workspaceSlug, onClose, onCreated }: Props) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [origins, setOrigins] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [newToken, setNewToken] = useState<string | null>(null);

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;
		setCreating(true);
		setError(null);
		try {
			const body: Record<string, unknown> = { name: name.trim() };
			if (description.trim()) body.description = description.trim();
			const parsed = parseOrigins(origins);
			if (parsed) body.allowedOrigins = parsed;
			const result = await apiFetch<NewSourceResult>(
				`/api/projects/${projectId}/feedback-sources`,
				{ method: "POST", workspaceSlug, body }
			);
			setNewToken(result.token);
			onCreated();
		} catch (e) {
			setError(String(e));
		} finally {
			setCreating(false);
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<div
			// CD-294: above the topbar (z-index: 110), below popovers (200).
			class="fixed inset-0 z-[120] flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
			onClick={(e) => {
				if (e.target === e.currentTarget && !newToken) onClose();
			}}
		>
			<div
				class={[
					"bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] max-h-[80vh] overflow-y-auto mx-4",
					"max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:max-h-[90vh] max-sm:mx-0",
				].join(" ")}
				role="dialog"
				aria-modal="true"
				aria-label="New feedback source"
			>
				<h2 class="mb-5 text-lg font-bold text-text-base">New feedback source</h2>

				{newToken ? (
					<div class="bg-surface border border-border rounded-md p-4">
						<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
							⚠ Copy this token now — you won't be able to see it again.
						</p>
						<code class="block font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded break-all">
							{newToken}
						</code>
						<Button type="button" variant="primary" size="sm" class="mt-3" onClick={onClose}>
							Done
						</Button>
					</div>
				) : (
					<NewSourceForm
						name={name}
						setName={setName}
						description={description}
						setDescription={setDescription}
						origins={origins}
						setOrigins={setOrigins}
						creating={creating}
						error={error}
						onSubmit={handleCreate}
						onCancel={onClose}
					/>
				)}
			</div>
		</div>
	);
}
