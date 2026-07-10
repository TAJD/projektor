import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import { SectionHeading } from "../MetricHelp";

interface CodeHeatmapEntry {
	path: string;
	segment: string;
	isLeaf: boolean;
	distinctIssueCount: number;
	claimCount: number;
}

interface CodeHeatmapResponse {
	prefix: string;
	totalDistinctIssues: number;
	entries: CodeHeatmapEntry[];
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
	since: number;
	until: number;
}

function useCodeHeatmap(
	workspaceSlug: string | undefined,
	projectId: string,
	since: number,
	until: number
) {
	const [prefix, setPrefix] = useState("");
	const [data, setData] = useState<CodeHeatmapResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Range changes invalidate any drill-down — the previous prefix may not exist in the
	// new window's claim set, so resetting to the root avoids a stuck empty drill-down.
	useEffect(() => {
		setPrefix("");
	}, [since, until]);

	useEffect(() => {
		setLoading(true);
		setError(null);
		const query = new URLSearchParams({ since: String(since), until: String(until) });
		if (prefix) query.set("prefix", prefix);
		apiFetch<CodeHeatmapResponse>(
			`/api/projects/${encodeURIComponent(projectId)}/code-heatmap?${query}`,
			{ workspaceSlug }
		)
			.then((res) => setData(res))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [workspaceSlug, projectId, since, until, prefix]);

	return { prefix, setPrefix, data, loading, error };
}

function formatIssueCount(n: number): string {
	return `${n} ${n === 1 ? "issue" : "issues"}`;
}

// PROJ-332: sequential heat — one hue (the app accent), lighter-to-darker by each
// entry's distinct-issue count relative to the strongest sibling at this drill-down
// level (not a global max), so the ramp stays legible whether you're looking at a
// hot root directory or a quiet leaf one. `color-mix` reads --accent/--surface live,
// so it repaints on theme toggle for free — no canvas-bake workaround needed here.
function heatBackground(ratio: number): string {
	const pct = 14 + Math.round(70 * ratio);
	return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface))`;
}

function Breadcrumb({
	prefix,
	onNavigate,
}: {
	prefix: string;
	onNavigate: (prefix: string) => void;
}) {
	const segments = prefix ? prefix.split("/") : [];
	return (
		<div class="flex flex-wrap items-center gap-1 mb-3 text-[0.78rem]">
			<button
				type="button"
				onClick={() => onNavigate("")}
				class={`px-1.5 py-0.5 rounded hover:bg-border ${
					segments.length === 0 ? "font-semibold text-text-base" : "text-accent"
				}`}
			>
				All files
			</button>
			{segments.map((seg, i) => {
				const path = segments.slice(0, i + 1).join("/");
				const isLast = i === segments.length - 1;
				return (
					<span key={path} class="flex items-center gap-1">
						<span class="text-text-muted">/</span>
						<button
							type="button"
							onClick={() => onNavigate(path)}
							class={`px-1.5 py-0.5 rounded hover:bg-border ${
								isLast ? "font-semibold text-text-base" : "text-accent"
							}`}
						>
							{seg}
						</button>
					</span>
				);
			})}
		</div>
	);
}

function HeatmapRow({
	entry,
	ratio,
	onDrillDown,
}: {
	entry: CodeHeatmapEntry;
	ratio: number;
	onDrillDown: (path: string) => void;
}) {
	const content = (
		<>
			<span class="min-w-0 truncate text-[0.82rem] text-text-base" title={entry.path}>
				{entry.segment}
				{entry.isLeaf ? "" : "/"}
			</span>
			<span
				class="flex-1 min-w-[60px] h-5 rounded-[3px] overflow-hidden"
				style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}
			>
				<span
					class="block h-full rounded-r-[4px]"
					style={{ width: `${Math.max(4, ratio * 100)}%`, background: heatBackground(ratio) }}
				/>
			</span>
			<span class="w-[5.5rem] shrink-0 text-right text-[0.78rem] tabular-nums text-text-muted">
				{formatIssueCount(entry.distinctIssueCount)}
			</span>
		</>
	);

	const rowClass =
		"grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 py-1 px-2 rounded";

	if (entry.isLeaf) {
		return <div class={rowClass}>{content}</div>;
	}

	return (
		<button
			type="button"
			onClick={() => onDrillDown(entry.path)}
			class={`${rowClass} w-full text-left hover:bg-border cursor-pointer`}
			title={`View files under ${entry.path}`}
		>
			{content}
		</button>
	);
}

function CodeHeatmapEmptyState() {
	return (
		<div class="py-8 text-center">
			<p class="m-0 text-sm text-text-base">No file claims in this window yet</p>
			<p class="m-0 mt-1 text-[0.78rem] text-text-muted">
				This view is fed by <code class="text-[0.78rem]">claim_files</code> — it fills in once
				agents claim files while working issues on this project.
			</p>
		</div>
	);
}

// PROJ-332: "Where work lands" — a hand-rolled proportional bar list rather than a
// treemap (per the ticket's fallback: keep the dependency footprint small). Bars carry
// the sequential heat encoding; sizing (bar length) and shading (fill intensity) are
// redundant on purpose, which is what makes a "heat map" read at a glance.
export default function CodeHeatmap({ workspaceSlug, projectId, since, until }: Props) {
	const { prefix, setPrefix, data, loading, error } = useCodeHeatmap(
		workspaceSlug,
		projectId,
		since,
		until
	);

	const maxCount = data ? Math.max(1, ...data.entries.map((e) => e.distinctIssueCount)) : 1;

	return (
		<div class="mb-8">
			<SectionHeading
				metricId="code-heatmap"
				caption="Directories sized by distinct issues claiming files there — click a row to drill in"
			/>
			<div class="p-4 bg-surface border border-border rounded-lg">
				{loading && <p aria-live="polite">Loading…</p>}
				{!loading && error && (
					<p role="alert" class="text-[var(--danger-text)]">
						{error}
					</p>
				)}
				{!loading && !error && data && (
					<>
						<Breadcrumb prefix={prefix} onNavigate={setPrefix} />
						{data.entries.length === 0 ? (
							<CodeHeatmapEmptyState />
						) : (
							<div class="flex flex-col gap-0.5">
								{data.entries.map((entry) => (
									<HeatmapRow
										key={entry.path}
										entry={entry}
										ratio={entry.distinctIssueCount / maxCount}
										onDrillDown={setPrefix}
									/>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
