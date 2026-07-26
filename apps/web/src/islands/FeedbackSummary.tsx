import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface VersionSummary {
	appVersion: string | null;
	totalCount: number;
	withCommentCount: number;
	thumbsUpPct: number | null;
	avgFiveStar: number | null;
	lastSeenAt: number;
}

interface SourceSummary {
	sourceId: string;
	sourceName: string | null;
	totalCount: number;
	versions: VersionSummary[];
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
	sourceId: string;
}

function versionMetric(v: VersionSummary): string {
	const parts: string[] = [];
	if (v.thumbsUpPct !== null) parts.push(`👍 ${v.thumbsUpPct}%`);
	if (v.avgFiveStar !== null) parts.push(`${v.avgFiveStar.toFixed(1)}★ avg`);
	if (parts.length === 0) parts.push("No ratings");
	return parts.join(" · ");
}

export default function FeedbackSummary({ workspaceSlug, projectId, sourceId }: Props) {
	const [summary, setSummary] = useState<SourceSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchSummary = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<SourceSummary[]>(`/api/projects/${projectId}/feedback/summary`, {
				workspaceSlug,
			});
			const list = Array.isArray(data) ? data : [];
			setSummary(list.find((s) => s.sourceId === sourceId) ?? null);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, sourceId, workspaceSlug]);

	useEffect(() => {
		fetchSummary();
	}, [fetchSummary]);

	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	}
	if (loading) return <p aria-live="polite">Loading summary…</p>;
	if (!summary || summary.versions.length === 0) {
		return (
			<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
				No feedback yet.
			</div>
		);
	}

	return (
		<section class="flex flex-col gap-4">
			<div class="bg-surface rounded-lg border border-border p-4">
				<div class="flex items-baseline gap-2 mb-2">
					<span class="text-[0.8rem] text-text-muted">{summary.totalCount} total</span>
				</div>
				<ul class="flex flex-col gap-1">
					{summary.versions.map((v) => (
						<li
							key={v.appVersion ?? "unknown"}
							class="flex flex-wrap gap-x-3 text-[0.875rem] text-text-muted"
						>
							<span class="font-medium text-text-base">{v.appVersion ?? "Unknown version"}</span>
							<span>{versionMetric(v)}</span>
							{v.withCommentCount > 0 && <span>{v.withCommentCount} with comments</span>}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
