import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface FeedbackSource {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

interface NewSourceResult {
	id: string;
	token: string;
}

interface Props {
	workspaceSlug?: string;
	projectId?: string;
}

const INPUT_CLASS =
	"px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";
const TD = "px-3 py-2 border-b border-border align-middle text-[0.875rem]";
const TH =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

function parseOrigins(raw: string): string[] | undefined {
	const list = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

export default function FeedbackSourceManager({ workspaceSlug, projectId: projectIdProp }: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);
	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [showCreate, setShowCreate] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [origins, setOrigins] = useState("");
	const [creating, setCreating] = useState(false);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [rotateId, setRotateId] = useState<string | null>(null);

	const fetchSources = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		setForbidden(false);
		try {
			const data = await apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, {
				workspaceSlug,
			});
			setSources(Array.isArray(data) ? data : []);
		} catch (e) {
			if (String(e).includes(": 403")) setForbidden(true);
			else setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, workspaceSlug]);

	useEffect(() => {
		fetchSources();
	}, [fetchSources]);

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;
		setCreating(true);
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
			setName("");
			setDescription("");
			setOrigins("");
			await fetchSources();
		} catch (e) {
			setError(String(e));
		} finally {
			setCreating(false);
		}
	}

	async function toggleActive(s: FeedbackSource) {
		await apiFetch(`/api/projects/${projectId}/feedback-sources/${s.id}`, {
			method: "PATCH",
			workspaceSlug,
			body: { isActive: !s.isActive },
		});
		await fetchSources();
	}

	async function confirmRotate(id: string) {
		const result = await apiFetch<{ token: string }>(
			`/api/projects/${projectId}/feedback-sources/${id}/rotate`,
			{ method: "POST", workspaceSlug }
		);
		setRotateId(null);
		setNewToken(result.token);
		await fetchSources();
	}

	async function revoke(id: string) {
		await apiFetch(`/api/projects/${projectId}/feedback-sources/${id}`, {
			method: "DELETE",
			workspaceSlug,
		});
		await fetchSources();
	}

	if (loading) return <p aria-live="polite">Loading feedback sources…</p>;
	if (forbidden) {
		return (
			<div class="p-4 bg-surface border border-border rounded-md text-text-muted">
				<strong>Access denied.</strong> Only workspace owners and admins can manage feedback
				sources.
			</div>
		);
	}
	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load feedback sources: {error}
			</p>
		);
	}

	return (
		<section class="mb-8">
			<div class="flex justify-between items-center mb-4">
				<h3 class="m-0 text-base font-semibold text-text-base">Feedback sources</h3>
				{!showCreate && (
					<button type="button" class="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
						+ New source
					</button>
				)}
			</div>

			{newToken && (
				<div class="bg-surface border border-border rounded-md p-4 mb-4">
					<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
						⚠ Copy this token now — you won't be able to see it again.
					</p>
					<code class="block font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded break-all">
						{newToken}
					</code>
					<button
						type="button"
						class="btn btn-outline btn-sm mt-2"
						onClick={() => setNewToken(null)}
					>
						Done
					</button>
				</div>
			)}

			{showCreate && (
				<form
					onSubmit={handleCreate}
					class="mb-5 px-4 py-4 bg-surface border border-border rounded-lg"
				>
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-name">
							Name *
						</label>
						<input
							id="fs-name"
							class={`w-full ${INPUT_CLASS}`}
							value={name}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							required
							maxLength={100}
						/>
					</div>
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-desc">
							Description
						</label>
						<input
							id="fs-desc"
							class={`w-full ${INPUT_CLASS}`}
							value={description}
							onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
							maxLength={500}
						/>
					</div>
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-origins">
							Allowed origins (one per line, optional)
						</label>
						<textarea
							id="fs-origins"
							class={`w-full ${INPUT_CLASS}`}
							rows={2}
							value={origins}
							onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)}
						/>
					</div>
					<div class="flex gap-2">
						<button
							type="submit"
							class="btn btn-primary btn-sm"
							disabled={creating || !name.trim()}
						>
							{creating ? "Creating…" : "Create source"}
						</button>
						<button
							type="button"
							class="btn btn-outline btn-sm"
							onClick={() => setShowCreate(false)}
							disabled={creating}
						>
							Cancel
						</button>
					</div>
				</form>
			)}

			{sources.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback sources yet.
				</div>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr>
								<th class={TH}>Name</th>
								<th class={TH}>Description</th>
								<th class={TH}>Active</th>
								<th class={TH}>Token</th>
								<th class={TH}>Created</th>
								<th class={TH}></th>
							</tr>
						</thead>
						<tbody>
							{sources.map((s) => (
								<tr key={s.id}>
									<td class={`${TD} font-medium text-text-base`}>{s.name}</td>
									<td class={`${TD} text-text-muted`}>{s.description ?? "—"}</td>
									<td class={TD}>
										<button
											type="button"
											class="btn btn-outline btn-sm"
											onClick={() => toggleActive(s)}
										>
											{s.isActive ? "Active" : "Inactive"}
										</button>
									</td>
									<td class={`${TD} font-mono text-[0.8rem] text-text-muted`}>{s.tokenPreview}</td>
									<td class={`${TD} text-text-muted`}>{formatDate(s.createdAt)}</td>
									<td class={`${TD} whitespace-nowrap`}>
										{rotateId === s.id ? (
											<span class="inline-flex gap-[0.375rem] items-center">
												<span class="text-[0.8rem] text-text-muted">Rotate? Old token dies.</span>
												<button
													type="button"
													class="btn btn-danger btn-sm"
													onClick={() => confirmRotate(s.id)}
												>
													Yes
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => setRotateId(null)}
												>
													No
												</button>
											</span>
										) : (
											<span class="inline-flex gap-[0.375rem]">
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => setRotateId(s.id)}
												>
													Rotate
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm text-[var(--danger-text)] border-[var(--danger-border)]"
													onClick={() => revoke(s.id)}
												>
													Revoke
												</button>
											</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
