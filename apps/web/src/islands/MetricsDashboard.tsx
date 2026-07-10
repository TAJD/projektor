import { useEffect, useMemo, useState } from "preact/hooks";
import uPlot from "uplot";
import { apiFetch } from "../utils/api-client";
import UplotChart, { createTooltipPlugin } from "./charts/UplotChart";

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
	throughputOverTime: Array<{ weekStart: string; count: number }>;
}

interface Props {
	workspaceSlug?: string;
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

function useFlowMetrics(workspaceSlug: string | undefined) {
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
		apiFetch<FlowMetrics>(`/api/projects/${encodeURIComponent(projectId)}/flow-metrics`, {
			workspaceSlug,
		})
			.then((data) => setMetrics(data))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [projectId, workspaceSlug]);

	return { projectId, metrics, loading, error };
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

function DistributionTiles({ title, dist }: { title: string; dist: Distribution }) {
	return (
		<div class="mb-8">
			<h2 class="m-0 mb-3 text-base font-semibold text-text-base">{title}</h2>
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<StatTile label="Count" value={String(dist.count)} />
				<StatTile label="Avg" value={formatDuration(dist.avg)} />
				<StatTile label="p50" value={formatDuration(dist.p50)} />
				<StatTile label="p90" value={formatDuration(dist.p90)} />
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
	const labels = useMemo(() => data.map((d) => d.weekStart), [data]);
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
	const { projectId, metrics, loading, error } = useFlowMetrics(workspaceSlug);

	if (!projectId && !loading) {
		return <p class="text-text-muted">No project specified. Add ?projectId= to the URL.</p>;
	}

	if (loading) return <p aria-live="polite">Loading metrics…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	if (!metrics) return null;

	return (
		<div>
			<h1 class="m-0 mb-5 text-2xl font-bold text-text-base">Metrics</h1>

			<div class="mb-8">
				<h2 class="m-0 mb-3 text-base font-semibold text-text-base">Throughput</h2>
				<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
					<ThroughputChart data={metrics.throughputOverTime} />
				</div>
			</div>

			<DistributionTiles title="Lead time" dist={metrics.leadTime} />
			<DistributionTiles title="Cycle time" dist={metrics.cycleTime} />

			<div class="mb-8">
				<h2 class="m-0 mb-3 text-base font-semibold text-text-base">WIP over time</h2>
				<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
					<WipChart data={metrics.wipOverTime} />
				</div>
			</div>
		</div>
	);
}
