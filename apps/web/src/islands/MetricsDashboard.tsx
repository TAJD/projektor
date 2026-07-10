import { useEffect, useMemo, useState } from "preact/hooks";
import uPlot from "uplot";
import { apiFetch } from "../utils/api-client";
import UplotChart, { createTooltipPlugin } from "./charts/UplotChart";
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
	// PROJ-328: collaboration-shape metrics — human attention, not agent-vs-human split.
	reviewLatency: Distribution;
	reviewLatencyOverTime: Array<{ bucketStart: string; p50: number | null }>;
	humanInterventions: Distribution;
	autonomyRatio: Distribution;
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

// uPlot bakes colors into the canvas at creation time, so callers re-read these live
// (rather than caching) whenever a chart is (re)built, including on theme toggle.
function readThemeColor(token: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	return value || fallback;
}

function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) return hex;
	const [r, g, b] = match.slice(1).map((h) => parseInt(h, 16));
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatShortDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatFullDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
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

// `help` is a one-line accessible explanation (rendered as a native tooltip via title=)
// for metrics whose meaning isn't obvious from the label alone — a dedicated help-icon
// system is PROJ-335, later in this epic; this is the interim, no-build-required version.
function DistributionTiles({
	title,
	dist,
	help,
	format = formatDuration,
}: {
	title: string;
	dist: Distribution;
	help?: string;
	format?: (v: number | null) => string;
}) {
	return (
		<div class="mb-8">
			<h2 class="m-0 mb-1 text-base font-semibold text-text-base" title={help}>
				{title}
			</h2>
			{help && <p class="m-0 mb-3 text-[0.72rem] text-text-muted">{help}</p>}
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<StatTile label="Count" value={String(dist.count)} />
				<StatTile label="Avg" value={format(dist.avg)} />
				<StatTile label="p50" value={format(dist.p50)} />
				<StatTile label="p90" value={format(dist.p90)} />
			</div>
		</div>
	);
}

function EmptyChartState({ message }: { message: string }) {
	return (
		<div class="flex items-center justify-center h-[220px] text-sm text-text-muted">{message}</div>
	);
}

function ThroughputChart({ data }: { data: FlowMetrics["throughputOverTime"] }) {
	const labels = useMemo(() => data.map((d) => d.bucketStart), [data]);
	const chartData = useMemo<uPlot.AlignedData>(
		() => [data.map((_, i) => i), data.map((d) => d.count)],
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
					{
						label: "Issues completed",
						stroke: accent,
						fill: hexToRgba(accent, 0.25),
						paths: uPlot.paths.bars?.(),
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
							for (let i = 0; i < n; i += stride) idxs.push(i);
							if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
							return idxs;
						},
						values: (_u, splits) => splits.map((s) => formatShortDate(labels[s] ?? "")),
					},
					{ stroke: textMuted, grid: { stroke: border } },
				],
				plugins: [
					createTooltipPlugin({
						formatX: (xVal) => formatFullDate(labels[xVal] ?? ""),
						formatY: (yVal) => `${yVal} completed`,
					}),
				],
			};
		};
	}, [labels]);

	if (data.length === 0 || data.every((d) => d.count === 0)) {
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
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");
			const wipLine = "#0d9488";

			return {
				width,
				height,
				scales: { x: { time: true } },
				legend: { show: false },
				series: [{}, { label: "WIP", stroke: wipLine, width: 2 }],
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
					<div class="mb-8">
						<h2 class="m-0 mb-3 text-base font-semibold text-text-base">Throughput</h2>
						<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
							<ThroughputChart data={metrics.throughputOverTime} />
						</div>
					</div>

					<DistributionTiles title="Lead time" dist={metrics.leadTime} />
					<DistributionTiles title="Cycle time" dist={metrics.cycleTime} />

					<div class="mb-8">
						<h2
							class="m-0 mb-1 text-base font-semibold text-text-base"
							title="Time from entering review to done — the primary human choke point"
						>
							Review latency
						</h2>
						<p class="m-0 mb-3 text-[0.72rem] text-text-muted">
							Time from entering review to done — the primary human choke point
						</p>
						<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto mb-3">
							<ReviewLatencyChart data={metrics.reviewLatencyOverTime} />
						</div>
						<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
							<StatTile label="Count" value={String(metrics.reviewLatency.count)} />
							<StatTile label="Avg" value={formatDuration(metrics.reviewLatency.avg)} />
							<StatTile label="p50" value={formatDuration(metrics.reviewLatency.p50)} />
							<StatTile label="p90" value={formatDuration(metrics.reviewLatency.p90)} />
						</div>
					</div>

					<DistributionTiles
						title="Human interventions per issue"
						dist={metrics.humanInterventions}
						help="Human-authored comments plus status bounces (review → in progress), per completed issue"
						format={formatCount}
					/>

					<DistributionTiles
						title="Autonomy ratio"
						dist={metrics.autonomyRatio}
						help="Lease-held time ÷ total cycle time, per completed issue — how much of the work an agent did unattended"
						format={formatPercent}
					/>

					<div class="mb-8">
						<h2 class="m-0 mb-3 text-base font-semibold text-text-base">WIP over time</h2>
						<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
							<WipChart data={metrics.wipOverTime} />
						</div>
					</div>
				</>
			)}
		</div>
	);
}
