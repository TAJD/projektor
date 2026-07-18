import { useEffect, useState } from "preact/hooks";
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
	projectId?: string;
}

function versionMetric(v: VersionSummary): string {
	const parts: string[] = [];
	if (v.thumbsUpPct !== null) parts.push(`👍 ${v.thumbsUpPct}%`);
	if (v.avgFiveStar !== null) parts.push(`${v.avgFiveStar.toFixed(1)}★ avg`);
	if (parts.length === 0) parts.push("No ratings");
	return parts.join(" · ");
}

export default function FeedbackSummary({ workspaceSlug, projectId: projectIdProp }: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);

	const [sources, setSources] = useState<SourceSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		apiFetch<SourceSummary[]>(`/api/projects/${projectId}/feedback/summary`, { workspaceSlug })
			.then((data) => {
				if (!cancelled) setSources(Array.isArray(data) ? data : []);
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, workspaceSlug]);

	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	}
	if (loading) return <p aria-live="polite">Loading summary…</p>;
	if (sources.length === 0) {
		return (
			<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border mb-4">
				No feedback yet.
			</div>
		);
	}

	return (
		<section class="mb-6 flex flex-col gap-4">
			{sources.map((s) => (
				<div key={s.sourceId} class="bg-surface rounded-lg border border-border p-4">
					<div class="flex items-baseline gap-2 mb-2">
						<h3 class="font-semibold text-text-base">{s.sourceName ?? "Untitled source"}</h3>
						<span class="text-[0.8rem] text-text-muted">{s.totalCount} total</span>
					</div>
					<ul class="flex flex-col gap-1">
						{s.versions.map((v) => (
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
			))}
		</section>
	);
}
