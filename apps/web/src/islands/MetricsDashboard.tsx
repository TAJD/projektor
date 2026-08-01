import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type uPlot from "uplot";
import { apiFetch } from "../utils/api-client";
import CodeHeatmap from "./charts/CodeHeatmap";
import UplotChart, { createTooltipPlugin } from "./charts/UplotChart";
import { MetricHelp, SectionHeading } from "./MetricHelp";
import { METRIC_DEFINITIONS, type MetricId } from "./metric-definitions";
import {
	CfdChart,
	EmptyChartState,
	formatFullDate,
	formatShortDate,
	readChartSeqColors,
	readThemeColor,
	ThroughputChart,
} from "./metrics/flow-charts";
import Select, { type SelectOption } from "./Select";

interface Distribution {
	count: number;
	avg: number | null;
	p50: number | null;
	p90: number | null;
}

interface FlowMetrics {
	leadTime: Distribution;
	cycleTime: Distribution;
	wipOverTime: Array<{ date: string; count: number }>;
	throughputOverTime: Array<{ bucketStart: string; count: number }>;
	// PROJ-331: bug share of completed throughput — a rising trend signals the factory
	// shipping more defects, not just more work.
	bugShareOverTime: Array<{
		bucketStart: string;
		total: number;
		bugCount: number;
		bugSharePercent: number | null;
	}>;
	// PROJ-341: whether a "bug"-keyed task type exists in the workspace at all —
	// distinguishes "tracked, 0 bugs" from "not tracked, no matching type".
	bugTypeTracked: boolean;
	// PROJ-328: collaboration-shape metrics — human attention, not agent-vs-human split.
	reviewLatency: Distribution;
	reviewLatencyOverTime: Array<{ bucketStart: string; p50: number | null }>;
	humanInterventions: Distribution;
	autonomyRatio: Distribution;
	// PROJ-329: cumulative flow diagram + time-in-state breakdown.
	cfdOverTime: Array<{
		bucketStart: string;
		backlogTodo: number;
		inProgress: number;
		inReview: number;
		done: number;
	}>;
	timeInProgress: Distribution;
	// PROJ-330: arrival vs completion, flow efficiency, aging-WIP scatter.
	arrivalVsCompletionOverTime: Array<{
		bucketStart: string;
		created: number;
		completed: number;
		net: number;
	}>;
	flowEfficiency: Distribution;
	agingWip: Array<{ id: string; status: "in_progress" | "in_review"; ageSeconds: number }>;
	// PROJ-334: factory health — fault signals for the machinery itself, for the
	// selected window.
	factoryHealth: {
		leaseExpiries: number;
		abandonedClaims: number;
		gateRejections: number;
		// PROJ-342: claims denied for hitting the project's agent WIP cap.
		wipCapPressure: number;
	};
}

interface Props {
	workspaceSlug?: string;
}

type Granularity = "day" | "week";

interface RangeState {
	since: string; // yyyy-mm-dd
	until: string; // yyyy-mm-dd
	granularity: Granularity;
}

const GRANULARITY_OPTIONS: SelectOption[] = [
	{ value: "week", label: "Weekly" },
	{ value: "day", label: "Daily" },
];

function mondayOfWeek(d: Date): Date {
	const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
	monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
	return monday;
}

function toDateStr(d: Date): string {
	return d.toISOString().slice(0, 10);
}

// Default view = the current ISO week plus the preceding 5 weeks (6 weeks total), weekly (PROJ-326).
function defaultRange(): RangeState {
	const today = new Date();
	const monday = mondayOfWeek(today);
	monday.setUTCDate(monday.getUTCDate() - 5 * 7);
	return { since: toDateStr(monday), until: toDateStr(today), granularity: "week" };
}

function parseGranularity(v: string | null): Granularity {
	return v === "day" ? "day" : "week";
}

function dateStrToEpochStart(s: string): number {
	return Math.floor(Date.parse(`${s}T00:00:00Z`) / 1000);
}

function dateStrToEpochEnd(s: string): number {
	return dateStrToEpochStart(s) + 86399;
}

/** Reads since/until/granularity from the URL on mount, then keeps the URL in sync (PROJ-326). */
function useRangeUrlSync() {
	const [range, setRange] = useState<RangeState>(defaultRange);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const since = params.get("since");
		const until = params.get("until");
		const granularity = params.get("granularity");
		setRange((prev) => ({
			since: since ?? prev.since,
			until: until ?? prev.until,
			granularity: parseGranularity(granularity ?? prev.granularity),
		}));
	}, []);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		params.set("since", range.since);
		params.set("until", range.until);
		params.set("granularity", range.granularity);
		history.replaceState(null, "", `?${params.toString()}`);
	}, [range.since, range.until, range.granularity]);

	return [range, setRange] as const;
}

function formatDuration(seconds: number | null): string {
	if (seconds === null) return "—";
	const abs = Math.abs(seconds);
	if (abs < 60) return `${Math.round(seconds)}s`;
	if (abs < 3600) return `${(seconds / 60).toFixed(1)}m`;
	if (abs < 86400) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86400).toFixed(1)}d`;
}

function useFlowMetrics(workspaceSlug: string | undefined, range: RangeState) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const id = new URLSearchParams(window.location.search).get("projectId");
		setProjectId(id);
	}, []);

	useEffect(() => {
		if (!projectId) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		const query = new URLSearchParams({
			since: String(dateStrToEpochStart(range.since)),
			until: String(dateStrToEpochEnd(range.until)),
			granularity: range.granularity,
		});
		apiFetch<FlowMetrics>(`/api/projects/${encodeURIComponent(projectId)}/flow-metrics?${query}`, {
			workspaceSlug,
		})
			.then((data) => setMetrics(data))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [projectId, workspaceSlug, range.since, range.until, range.granularity]);

	// cofferdam-ignore: Consistency.ErrorHandlingIdiom: hook returns {data,error,loading} state, standard in this codebase
	return { projectId, metrics, loading, error };
}

function RangeControls({
	range,
	setRange,
}: {
	range: RangeState;
	setRange: (fn: (prev: RangeState) => RangeState) => void;
}) {
	return (
		<div class="flex flex-wrap items-end gap-4 mb-6">
			<label class="text-[0.7rem] text-text-muted">
				From
				<input
					type="date"
					aria-label="From date"
					value={range.since}
					max={range.until}
					onInput={(e) => {
						const value = (e.target as HTMLInputElement).value;
						if (value) setRange((prev) => ({ ...prev, since: value }));
					}}
					class="block px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base mt-[0.2rem]"
				/>
			</label>
			<label class="text-[0.7rem] text-text-muted">
				To
				<input
					type="date"
					aria-label="To date"
					value={range.until}
					min={range.since}
					onInput={(e) => {
						const value = (e.target as HTMLInputElement).value;
						if (value) setRange((prev) => ({ ...prev, until: value }));
					}}
					class="block px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base mt-[0.2rem]"
				/>
			</label>
			<div class="text-[0.7rem] text-text-muted">
				Granularity
				<div class="mt-[0.2rem]">
					<Select
						value={range.granularity}
						options={GRANULARITY_OPTIONS}
						ariaLabel="Chart granularity"
						onChange={(value) =>
							setRange((prev) => ({ ...prev, granularity: value as Granularity }))
						}
					/>
				</div>
			</div>
		</div>
	);
}

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div class="px-4 py-3 bg-surface border border-border rounded-lg min-w-0">
			<p class="m-0 mb-1 text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
				{label}
			</p>
			<p class="m-0 text-lg font-semibold text-text-base">{value}</p>
		</div>
	);
}

function formatCount(n: number | null): string {
	return n === null ? "—" : n.toFixed(1);
}

function formatPercent(n: number | null): string {
	return n === null ? "—" : `${Math.round(n * 100)}%`;
}

// title/caption are optional overrides for when the group's on-screen heading differs
// from the definitions-map label (e.g. "Human interventions per issue" vs. the map's
// "Human interventions"); the MetricHelp popover always uses the map copy.
// showHeading=false drops the h2+MetricHelp+caption entirely, for call sites where a
// SectionHeading above already draws the heading (e.g. the Review-latency section) — every
// 4-tile block on the dashboard goes through this one component either way, so tile density
// and typography stay identical whichever heading mode is used.
function DistributionTiles({
	metricId,
	title,
	caption,
	dist,
	format = formatDuration,
	showHeading = true,
}: {
	metricId: MetricId;
	title?: string;
	caption?: string;
	dist: Distribution;
	format?: (v: number | null) => string;
	showHeading?: boolean;
}) {
	const def = METRIC_DEFINITIONS[metricId];
	return (
		<div class="mb-8">
			{showHeading && (
				<h2 class="m-0 mb-1 text-base font-semibold text-text-base inline-flex items-center gap-1.5">
					{title ?? def.label}
					<MetricHelp id={metricId} />
				</h2>
			)}
			{showHeading && caption && <p class="m-0 mb-3 text-[0.72rem] text-text-muted">{caption}</p>}
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<StatTile label="Count" value={String(dist.count)} />
				<StatTile label="Avg" value={format(dist.avg)} />
				<StatTile label="p50" value={format(dist.p50)} />
				<StatTile label="p90" value={format(dist.p90)} />
			</div>
		</div>
	);
}

// PROJ-334: factory health tiles — fault signals for the machinery itself. Visually
// distinct from the neutral StatTile (amber accent, reusing the existing
// --priority-high tokens) but only when nonzero — a healthy low background rate of
// expiries/bounces stays neutral so the row doesn't read as alarmist by default.
function HealthTile({ metricId, value }: { metricId: MetricId; value: number }) {
	const def = METRIC_DEFINITIONS[metricId];
	const flagged = value > 0;
	return (
		<div
			class={`px-4 py-3 bg-surface border rounded-lg min-w-0 ${flagged ? "" : "border-border"}`}
			style={
				flagged
					? { borderColor: "var(--priority-high-text)", background: "var(--priority-high-bg)" }
					: undefined
			}
		>
			<p
				class={
					"m-0 mb-1 text-[0.72rem] font-semibold text-text-muted uppercase " +
					"tracking-[0.04em] inline-flex items-center gap-1"
				}
			>
				{def.label}
				<MetricHelp id={metricId} />
			</p>
			<p
				class={`m-0 text-lg font-semibold ${flagged ? "" : "text-text-base"}`}
				style={flagged ? { color: "var(--priority-high-text)" } : undefined}
			>
				{value}
			</p>
		</div>
	);
}

// PROJ-331: bug share % trend line, chosen over stacked-bars-by-type per the ticket's
// "or" — this dashboard already has a lot of charts landing in this epic, and a single
// trend line answers the ticket's actual question ("is the factory shipping more
// defects?") without adding a new per-type legend/color scheme to learn. Buckets with
// no completions are gapped (null) rather than drawn as 0%, so an empty bucket reads as
// "no data" rather than "no bugs".
function BugShareChart({
	data,
	bugTypeTracked,
}: {
	data: FlowMetrics["bugShareOverTime"];
	bugTypeTracked: boolean;
}) {
	const labels = useMemo(() => data.map((d) => d.bucketStart), [data]);
	const chartData = useMemo<uPlot.AlignedData>(
		() => [data.map((_, i) => i), data.map((d) => d.bugSharePercent)],
		[data]
	);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const accent = readThemeColor("--accent", "#4f46e5");
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");

			return {
				width,
				height,
				scales: { x: { time: false }, y: { range: [0, 1] } },
				legend: { show: false },
				series: [{}, { label: "Bug share", stroke: accent, width: 2, points: { show: true } }],
				axes: [
					{
						stroke: textMuted,
						grid: { stroke: border },
						splits: (u) => {
							const n = labels.length;
							const maxTicks = Math.max(2, Math.floor(u.width / 70));
							const stride = Math.max(1, Math.ceil(n / maxTicks));
							const idxs: number[] = [];
							// cofferdam-ignore: Refactor.PreferArrayMethodOverLoop: variable stride, not a 1:1 map
							for (let i = 0; i < n; i += stride) idxs.push(i);
							if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
							return idxs;
						},
						values: (_u, splits) => splits.map((s) => formatShortDate(labels[s] ?? "")),
					},
					{
						stroke: textMuted,
						grid: { stroke: border },
						values: (_u, ticks) => ticks.map((v) => formatPercent(v as number)),
					},
				],
				plugins: [
					createTooltipPlugin({
						formatX: (xVal) => formatFullDate(labels[xVal] ?? ""),
						formatY: (yVal) => formatPercent(yVal),
					}),
				],
			};
		};
	}, [labels]);

	if (!bugTypeTracked) {
		return (
			<EmptyChartState message='Not tracked — no task type keyed "bug" exists in this workspace' />
		);
	}

	if (data.length === 0 || data.every((d) => d.bugSharePercent === null)) {
		return <EmptyChartState message="No completed issues yet" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}

// PROJ-328: p50 review latency per bucket — the trend for the primary human choke point.
function ReviewLatencyChart({ data }: { data: FlowMetrics["reviewLatencyOverTime"] }) {
	const labels = useMemo(() => data.map((d) => d.bucketStart), [data]);
	const chartData = useMemo<uPlot.AlignedData>(
		() => [data.map((_, i) => i), data.map((d) => d.p50)],
		[data]
	);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const accent = readThemeColor("--accent", "#4f46e5");
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");

			return {
				width,
				height,
				scales: { x: { time: false } },
				legend: { show: false },
				series: [
					{},
					{ label: "Review latency (p50)", stroke: accent, width: 2, points: { show: true } },
				],
				axes: [
					{
						stroke: textMuted,
						grid: { stroke: border },
						splits: (u) => {
							const n = labels.length;
							const maxTicks = Math.max(2, Math.floor(u.width / 70));
							const stride = Math.max(1, Math.ceil(n / maxTicks));
							const idxs: number[] = [];
							// cofferdam-ignore: Refactor.PreferArrayMethodOverLoop: variable stride, not a 1:1 map
							for (let i = 0; i < n; i += stride) idxs.push(i);
							if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
							return idxs;
						},
						values: (_u, splits) => splits.map((s) => formatShortDate(labels[s] ?? "")),
					},
					{
						stroke: textMuted,
						grid: { stroke: border },
						values: (_u, ticks) => ticks.map((v) => formatDuration(v)),
					},
				],
				plugins: [
					createTooltipPlugin({
						formatX: (xVal) => formatFullDate(labels[xVal] ?? ""),
						formatY: (yVal) => formatDuration(yVal),
					}),
				],
			};
		};
	}, [labels]);

	if (data.length === 0 || data.every((d) => d.p50 === null)) {
		return <EmptyChartState message="No review-latency data yet" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}

function WipChart({ data }: { data: FlowMetrics["wipOverTime"] }) {
	const chartData = useMemo<uPlot.AlignedData>(
		() => [
			data.map((d) => Math.floor(new Date(d.date).getTime() / 1000)),
			data.map((d) => d.count),
		],
		[data]
	);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const accent = readThemeColor("--accent", "#4f46e5");
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");

			return {
				width,
				height,
				scales: { x: { time: true } },
				legend: { show: false },
				series: [{}, { label: "WIP", stroke: accent, width: 2 }],
				axes: [
					{ stroke: textMuted, grid: { stroke: border }, space: 60 },
					{ stroke: textMuted, grid: { stroke: border } },
				],
				plugins: [
					createTooltipPlugin({
						formatX: (xVal) =>
							new Date(xVal * 1000).toLocaleDateString("en-US", {
								month: "short",
								day: "numeric",
								year: "numeric",
								timeZone: "UTC",
							}),
						formatY: (yVal) => `${yVal} in progress`,
					}),
				],
			};
		};
	}, []);

	if (data.length === 0 || data.every((d) => d.count === 0)) {
		return <EmptyChartState message="No WIP data yet" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}

// PROJ-330: arrival vs completion. Created and completed share one axis (both counts),
// per the "never dual-axis" rule; net is derived from the other two so it gets a muted
// dashed line rather than a third categorical hue. "Completed" reuses the accent color
// ThroughputChart already uses for the same concept; "Created" is the dashboard's second
// categorical color (--chart-secondary, Base.astro), validated against --accent with
// scripts/validate_palette.js.
function ArrivalVsCompletionChart({ data }: { data: FlowMetrics["arrivalVsCompletionOverTime"] }) {
	const labels = useMemo(() => data.map((d) => d.bucketStart), [data]);
	const chartData = useMemo<uPlot.AlignedData>(
		() => [
			data.map((_, i) => i),
			data.map((d) => d.created),
			data.map((d) => d.completed),
			data.map((d) => d.net),
		],
		[data]
	);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const accent = readThemeColor("--accent", "#4f46e5");
			const chartSecondary = readThemeColor("--chart-secondary", "#d97706");
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");

			return {
				width,
				height,
				scales: { x: { time: false } },
				legend: { show: true },
				series: [
					{},
					{ label: "Created", stroke: chartSecondary, width: 2, points: { show: false } },
					{ label: "Completed", stroke: accent, width: 2, points: { show: false } },
					{
						label: "Net (created − completed)",
						stroke: textMuted,
						width: 1,
						dash: [4, 4],
						points: { show: false },
					},
				],
				axes: [
					{
						stroke: textMuted,
						grid: { stroke: border },
						splits: (u) => {
							const n = labels.length;
							const maxTicks = Math.max(2, Math.floor(u.width / 70));
							const stride = Math.max(1, Math.ceil(n / maxTicks));
							const idxs: number[] = [];
							// cofferdam-ignore: Refactor.PreferArrayMethodOverLoop: variable stride, not a 1:1 map
							for (let i = 0; i < n; i += stride) idxs.push(i);
							if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
							return idxs;
						},
						values: (_u, splits) => splits.map((s) => formatShortDate(labels[s] ?? "")),
					},
					{ stroke: textMuted, grid: { stroke: border } },
				],
			};
		};
	}, [labels]);

	if (data.length === 0 || data.every((d) => d.created === 0 && d.completed === 0)) {
		return <EmptyChartState message="No arrivals or completions yet" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}

// PROJ-330: aging-WIP scatter. x is the two open statuses (jittered slightly per-issue so
// overlapping ages are visible, a beeswarm-lite); y is age since claim. p50/p90 reference
// lines reuse this window's cycleTime distribution (already returned alongside agingWip)
// rather than a separate all-time query, so the baseline moves with the shared date-range
// controls same as every other chart on this page. Colors reuse the --chart-seq-* tokens so
// "in progress" / "in review" read the same hue here as in the cumulative-flow chart above.
const AGING_WIP_STATUS_X: Record<"in_progress" | "in_review", number> = {
	in_progress: 0,
	in_review: 1,
};

function hashJitter(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return ((h >>> 0) % 1000) / 1000;
}

function AgingWipScatter({
	data,
	p50,
	p90,
}: {
	data: FlowMetrics["agingWip"];
	p50: number | null;
	p90: number | null;
}) {
	const points = useMemo(
		() =>
			data
				.map((d) => ({ ...d, x: AGING_WIP_STATUS_X[d.status] + (hashJitter(d.id) - 0.5) * 0.5 }))
				.sort((a, b) => a.x - b.x),
		[data]
	);

	const chartData = useMemo<uPlot.AlignedData>(() => {
		const xs = points.map((p) => p.x);
		return [xs, points.map((p) => p.ageSeconds), xs.map(() => p50), xs.map(() => p90)];
	}, [points, p50, p90]);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");
			const seq = readChartSeqColors();

			return {
				width,
				height,
				scales: { x: { time: false, range: [-0.5, 1.5] } },
				legend: { show: true },
				series: [
					{},
					{
						label: "Age since claim",
						stroke: seq.inProgress,
						points: { show: true, size: 8 },
						paths: () => null,
					},
					{
						label: "p50 cycle time",
						stroke: textMuted,
						width: 1,
						dash: [4, 4],
						points: { show: false },
					},
					{
						label: "p90 cycle time",
						stroke: textMuted,
						width: 1,
						dash: [2, 2],
						points: { show: false },
					},
				],
				axes: [
					{
						stroke: textMuted,
						grid: { stroke: border },
						splits: () => [0, 1],
						values: (_u, splits) => splits.map((s) => (s === 0 ? "In progress" : "In review")),
					},
					{
						stroke: textMuted,
						grid: { stroke: border },
						values: (_u, ticks) => ticks.map((v) => formatDuration(v)),
					},
				],
			};
		};
	}, []);

	if (data.length === 0) {
		return <EmptyChartState message="No issues currently in progress or review" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}

// PROJ-325 polish pass: groups the dashboard's ~14 panels into a narrative order (Flow →
// Efficiency & collaboration → Where work lands → Factory health) instead of landing order.
// Reuses the existing h2 pattern rather than a new layout primitive — just a heavier/larger
// h2 with a bottom rule to read as a band header above the per-metric h2s inside it.
// title is omitted for the "Where work lands" band: its single panel (CodeHeatmap) already
// renders its own SectionHeading with the same label, so a second h2 would be a literal
// duplicate rather than a useful band header.
function SectionBand({ title, children }: { title?: string; children: ComponentChildren }) {
	return (
		<section class="mb-10">
			{title && (
				<h2 class="m-0 mb-4 pb-2 text-lg font-bold text-text-base border-b border-border">
					{title}
				</h2>
			)}
			<div class="flex flex-col">{children}</div>
		</section>
	);
}

export default function MetricsDashboard({ workspaceSlug }: Props) {
	const [range, setRange] = useRangeUrlSync();
	const { projectId, metrics, loading, error } = useFlowMetrics(workspaceSlug, range);

	if (!projectId && !loading) {
		return <p class="text-text-muted">No project specified. Add ?projectId= to the URL.</p>;
	}

	return (
		<div>
			<h1 class="m-0 mb-5 text-2xl font-bold text-text-base">Metrics</h1>

			<RangeControls range={range} setRange={setRange} />

			{loading && <p aria-live="polite">Loading metrics…</p>}
			{!loading && error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}
			{!loading && !error && metrics && (
				<>
					<SectionBand title="Flow">
						<DistributionTiles metricId="lead-time" dist={metrics.leadTime} />
						<DistributionTiles metricId="cycle-time" dist={metrics.cycleTime} />

						<div class="mb-8">
							<SectionHeading metricId="throughput" />
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
								<ThroughputChart data={metrics.throughputOverTime} />
							</div>
						</div>

						<div class="mb-8">
							<SectionHeading
								metricId="bug-share"
								caption="Bugs as a share of completed throughput — a rising trend is a quality signal, not just a volume one"
							/>
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
								<BugShareChart
									data={metrics.bugShareOverTime}
									bugTypeTracked={metrics.bugTypeTracked}
								/>
							</div>
						</div>

						<div class="mb-8">
							<SectionHeading metricId="wip" />
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
								<WipChart data={metrics.wipOverTime} />
							</div>
						</div>

						<div class="mb-8">
							<SectionHeading
								metricId="aging-wip"
								caption={
									"Age since claim for every currently open issue, against this window's cycle-time " +
									"p50/p90 — stuck items show up before they finish and skew the percentiles"
								}
							/>
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
								<AgingWipScatter
									data={metrics.agingWip}
									p50={metrics.cycleTime.p50}
									p90={metrics.cycleTime.p90}
								/>
							</div>
						</div>

						<div class="mb-8">
							<SectionHeading
								metricId="cumulative-flow"
								caption="Issue counts per status category over time — a widening band is where the factory is choking"
							/>
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto mb-3">
								<CfdChart data={metrics.cfdOverTime} />
							</div>
							{/* PROJ-392: Review latency isn't a second 4-tile group — pairing a dense
							    4-tile card with a near-empty one in a two-column grid read as a
							    visual bug (implying parity where there isn't any). Time-in-progress
							    now takes the full row; the caption below points to the canonical
							    Review-latency breakdown instead. */}
							<DistributionTiles
								metricId="time-in-progress"
								caption="Review latency has its own breakdown in Efficiency & collaboration, below"
								dist={metrics.timeInProgress}
							/>
						</div>

						<div class="mb-8">
							<SectionHeading
								metricId="arrival-vs-completion"
								caption="Issues created vs completed per bucket, with the net — is the backlog growing or burning?"
							/>
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
								<ArrivalVsCompletionChart data={metrics.arrivalVsCompletionOverTime} />
							</div>
						</div>
					</SectionBand>

					<SectionBand title="Efficiency & collaboration">
						<DistributionTiles
							metricId="flow-efficiency"
							caption="Lease-held time ÷ lead time — how much of the wait, not just the work, was agent-driven"
							dist={metrics.flowEfficiency}
							format={formatPercent}
						/>

						<DistributionTiles
							metricId="autonomy-ratio"
							dist={metrics.autonomyRatio}
							format={formatPercent}
						/>

						<div class="mb-8">
							<SectionHeading metricId="review-latency" />
							<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto mb-3">
								<ReviewLatencyChart data={metrics.reviewLatencyOverTime} />
							</div>
							<DistributionTiles
								metricId="review-latency"
								dist={metrics.reviewLatency}
								showHeading={false}
							/>
						</div>

						<DistributionTiles
							metricId="human-interventions"
							title="Human interventions per issue"
							dist={metrics.humanInterventions}
							format={formatCount}
						/>
					</SectionBand>

					<SectionBand>
						{projectId && (
							<CodeHeatmap
								workspaceSlug={workspaceSlug}
								projectId={projectId}
								since={dateStrToEpochStart(range.since)}
								until={dateStrToEpochEnd(range.until)}
							/>
						)}
					</SectionBand>

					<SectionBand title="Factory health">
						<div class="mb-8">
							<p class="m-0 mb-3 text-[0.72rem] text-text-muted">
								Fault signals for the factory itself, for the selected window — a low background
								rate is normal; watch the trend, not any single nonzero tile
							</p>
							<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
								<HealthTile metricId="lease-expiries" value={metrics.factoryHealth.leaseExpiries} />
								<HealthTile
									metricId="abandoned-claims"
									value={metrics.factoryHealth.abandonedClaims}
								/>
								<HealthTile
									metricId="gate-rejections"
									value={metrics.factoryHealth.gateRejections}
								/>
								<HealthTile
									metricId="wip-cap-pressure"
									value={metrics.factoryHealth.wipCapPressure}
								/>
							</div>
						</div>
					</SectionBand>
				</>
			)}
		</div>
	);
}
