import { useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Input, Textarea } from "./ui/Input";

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
				<p role="alert" class="text-danger-text mb-3 text-sm">
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
				<Input
					id="fs-name"
					value={name}
					onInput={(e) => setName((e.target as HTMLInputElement).value)}
					required
					maxLength={100}
				/>
			</div>
			<div class="mb-[0.875rem]">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="fs-desc"
				>
					Description
				</label>
				<Input
					id="fs-desc"
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
				<Textarea
					id="fs-origins"
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
		<Dialog
			open={true}
			onClose={() => {
				if (!newToken) onClose();
			}}
			ariaLabel="New feedback source"
		>
			<h2 class="mb-5 text-lg font-bold text-text-base">New feedback source</h2>

			{newToken ? (
				<div class="bg-surface border border-border rounded-md p-4">
					<p class="text-danger-text text-[0.8rem] my-1">
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
		</Dialog>
	);
}
