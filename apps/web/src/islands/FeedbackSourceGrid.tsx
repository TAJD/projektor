import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import NewSourceModal from "./NewSourceModal";

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

interface SourceVersionSummary {
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
	versions: SourceVersionSummary[];
}

interface Props {
	workspaceSlug?: string;
	projectId?: string;
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

function statusLabel(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "Revoked";
	return s.isActive ? "Active" : "Inactive";
}

function statusClass(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "opacity-60";
	return s.isActive ? "" : "opacity-75";
}

const CARD_CLASS =
	"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg no-underline shadow-sm " +
	"transition-all duration-150 hover:border-accent hover:-translate-y-px";

function SourceCard({ source, summary }: { source: FeedbackSource; summary?: SourceSummary }) {
	const total = summary?.totalCount ?? 0;
	const lastSeenAt = summary?.versions.reduce((max, v) => Math.max(max, v.lastSeenAt), 0) ?? 0;
	return (
		<a href={`/feedback/${source.id}`} class={`${CARD_CLASS} ${statusClass(source)}`}>
			<div class="flex items-center justify-between gap-2">
				<span class="font-bold text-text-base">{source.name}</span>
				<span class="text-[0.7rem] font-medium px-1.5 py-0.5 rounded bg-bg border border-border text-text-muted">
					{statusLabel(source)}
				</span>
			</div>
			<span class="text-xs text-text-muted">
				{total === 0 ? "No feedback yet" : `${total} total`}
			</span>
			<span class="text-xs text-text-muted">
				{lastSeenAt > 0 ? `Last activity ${formatDate(lastSeenAt)}` : "No activity yet"}
			</span>
		</a>
	);
}

function NewSourceCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={`${CARD_CLASS} items-center justify-center text-text-muted font-medium min-h-[104px] cursor-pointer`}
		>
			+ New source
		</button>
	);
}

export default function FeedbackSourceGrid({ workspaceSlug, projectId: projectIdProp }: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);

	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [summaries, setSummaries] = useState<SourceSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(false);

	const fetchAll = useCallback(
		async (opts?: Readonly<{ background?: boolean }>) => {
			if (!projectId) return;
			if (!opts?.background) setLoading(true);
			setError(null);
			setForbidden(false);
			try {
				const [sourcesData, summaryData] = await Promise.all([
					apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, {
						workspaceSlug,
					}),
					apiFetch<SourceSummary[]>(`/api/projects/${projectId}/feedback/summary`, {
						workspaceSlug,
					}),
				]);
				setSources(Array.isArray(sourcesData) ? sourcesData : []);
				setSummaries(Array.isArray(summaryData) ? summaryData : []);
			} catch (e) {
				if (String(e).includes(": 403")) setForbidden(true);
				else setError(String(e));
			} finally {
				if (!opts?.background) setLoading(false);
			}
		},
		[projectId, workspaceSlug]
	);

	useEffect(() => {
		fetchAll();
	}, [fetchAll]);

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

	const summaryBySource = new Map(summaries.map((s) => [s.sourceId, s]));

	return (
		<section>
			<h1 class="text-xl font-bold text-text-base mb-4">Feedback sources</h1>
			<div
				class="grid gap-4"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
			>
				{sources.map((s) => (
					<SourceCard key={s.id} source={s} summary={summaryBySource.get(s.id)} />
				))}
				<NewSourceCard onClick={() => setShowCreate(true)} />
			</div>
			{showCreate && (
				<NewSourceModal
					projectId={projectId}
					workspaceSlug={workspaceSlug}
					onClose={() => setShowCreate(false)}
					onCreated={() => fetchAll({ background: true })}
				/>
			)}
		</section>
	);
}
