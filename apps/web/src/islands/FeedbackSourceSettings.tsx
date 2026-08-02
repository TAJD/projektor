import { useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

export interface FeedbackSource {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

export interface FeedbackVersionSummary {
	appVersion: string | null;
	totalCount: number;
	withCommentCount: number;
	thumbsUpPct: number | null;
	avgFiveStar: number | null;
	lastSeenAt: number;
}

interface Props {
	source: FeedbackSource;
	projectId: string;
	workspaceSlug?: string;
	onChanged: () => void;
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

export default function FeedbackSourceSettings({
	source,
	projectId,
	workspaceSlug,
	onChanged,
}: Props) {
	const [rotating, setRotating] = useState(false);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function toggleActive() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback-sources/${source.id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { isActive: !source.isActive },
			});
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	async function confirmRotate() {
		try {
			const result = await apiFetch<{ token: string }>(
				`/api/projects/${projectId}/feedback-sources/${source.id}/rotate`,
				{ method: "POST", workspaceSlug }
			);
			setRotating(false);
			setNewToken(result.token);
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	async function revoke() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback-sources/${source.id}`, {
				method: "DELETE",
				workspaceSlug,
			});
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<section class="flex flex-col gap-4 max-w-[520px]">
			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}

			{newToken && (
				<div class="bg-surface border border-border rounded-md p-4">
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

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Token</span>
				<code class="font-mono text-[0.85rem]">{source.tokenPreview}</code>
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Status</span>
				<button type="button" class="btn btn-outline btn-sm w-fit" onClick={toggleActive}>
					{source.isActive ? "Active" : "Inactive"}
				</button>
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Created</span>
				<span class="text-[0.875rem] text-text-base">{formatDate(source.createdAt)}</span>
			</div>

			<div class="flex flex-col gap-2">
				<span class="text-[0.8rem] font-semibold text-text-muted">Danger zone</span>
				{rotating ? (
					<span class="inline-flex gap-[0.375rem] items-center flex-wrap">
						<span class="text-[0.8rem] text-text-muted">Rotate? Old token dies.</span>
						<button type="button" class="btn btn-danger btn-sm" onClick={confirmRotate}>
							Yes
						</button>
						<button type="button" class="btn btn-outline btn-sm" onClick={() => setRotating(false)}>
							No
						</button>
					</span>
				) : (
					<span class="inline-flex gap-[0.375rem]">
						<button type="button" class="btn btn-outline btn-sm" onClick={() => setRotating(true)}>
							Rotate token
						</button>
						<button
							type="button"
							class="btn btn-outline btn-sm text-[var(--danger-text)] border-[var(--danger-border)]"
							onClick={revoke}
						>
							Revoke source
						</button>
					</span>
				)}
			</div>
		</section>
	);
}
