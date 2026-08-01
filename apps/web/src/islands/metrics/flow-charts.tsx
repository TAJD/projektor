import { useMemo } from "preact/hooks";
import uPlot from "uplot";
import UplotChart, { createTooltipPlugin } from "../charts/UplotChart";

export interface ThroughputPoint {
	bucketStart: string;
	count: number;
}

export interface CfdPoint {
	bucketStart: string;
	backlogTodo: number;
	inProgress: number;
	inReview: number;
	done: number;
}

// uPlot bakes colors into the canvas at creation time, so callers re-read these live
// (rather than caching) whenever a chart is (re)built, including on theme toggle.
export function readThemeColor(token: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	return value || fallback;
}

// cofferdam-ignore: Design.OrphanExport: color helper kept exported for module API consistency
export function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) return hex;
	const [r, g, b] = match.slice(1).map((h) => parseInt(h, 16));
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function formatShortDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatFullDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

// Single-hue ordinal ramp (lightest = earliest stage, darkest = done) for the CFD bands —
// read from the --chart-seq-* tokens (Base.astro) so the ramp repaints on theme toggle.
export function readChartSeqColors() {
	return {
		backlogTodo: readThemeColor("--chart-seq-1", "#86b6ef"),
		inProgress: readThemeColor("--chart-seq-2", "#5598e7"),
		inReview: readThemeColor("--chart-seq-3", "#2a78d6"),
		done: readThemeColor("--chart-seq-4", "#1c5cab"),
	};
}

export function EmptyChartState({ message }: { message: string }) {
	return (
		<div class="flex items-center justify-center h-[220px] text-sm text-text-muted">{message}</div>
	);
}

function tickIndices(width: number, labels: readonly string[]): number[] {
	const n = labels.length;
	const maxTicks = Math.max(2, Math.floor(width / 70));
	const stride = Math.max(1, Math.ceil(n / maxTicks));
	const idxs: number[] = [];
	// cofferdam-ignore: Refactor.PreferArrayMethodOverLoop: variable stride, not a 1:1 map over a fixed-length source
	for (let i = 0; i < n; i += stride) idxs.push(i);
	if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
	return idxs;
}

export function ThroughputChart({ data }: { data: ThroughputPoint[] }) {
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
						splits: (u) => tickIndices(u.width, labels),
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

// Bands are stacked bottom-up (done at the base, backlog/todo on top) by plotting
// cumulative sums and drawing widest-first so each later, narrower fill paints over the
// tail of the one before it — the classic uPlot stacked-area trick, since uPlot has no
// native "stacked" series mode.
export function CfdChart({ data }: { data: CfdPoint[] }) {
	const labels = useMemo(() => data.map((d) => d.bucketStart), [data]);
	const chartData = useMemo<uPlot.AlignedData>(() => {
		const total = data.map((d) => d.backlogTodo + d.inProgress + d.inReview + d.done);
		const upToInProgress = data.map((d) => d.inProgress + d.inReview + d.done);
		const upToInReview = data.map((d) => d.inReview + d.done);
		const done = data.map((d) => d.done);
		return [data.map((_, i) => i), total, upToInProgress, upToInReview, done];
	}, [data]);

	const buildOptions = useMemo(() => {
		return (width: number, height: number): uPlot.Options => {
			const border = readThemeColor("--border", "#e2e8f0");
			const textMuted = readThemeColor("--text-muted", "#6b7280");
			const seq = readChartSeqColors();

			return {
				width,
				height,
				scales: { x: { time: false } },
				legend: { show: true },
				series: [
					{},
					// Series carry cumulative sums (for the stacked-area geometry), so the legend
					// `value` de-cumulates each back to its own band count — otherwise the legend
					// would report the running total, not the band's actual size.
					{
						label: "Backlog/todo",
						stroke: seq.backlogTodo,
						fill: seq.backlogTodo,
						value: (u, _v, _si, i) =>
							i == null ? "" : (u.data[1][i] as number) - (u.data[2][i] as number),
					},
					{
						label: "In progress",
						stroke: seq.inProgress,
						fill: seq.inProgress,
						value: (u, _v, _si, i) =>
							i == null ? "" : (u.data[2][i] as number) - (u.data[3][i] as number),
					},
					{
						label: "In review",
						stroke: seq.inReview,
						fill: seq.inReview,
						value: (u, _v, _si, i) =>
							i == null ? "" : (u.data[3][i] as number) - (u.data[4][i] as number),
					},
					{
						label: "Done",
						stroke: seq.done,
						fill: seq.done,
						value: (_u, v) => v ?? "",
					},
				],
				axes: [
					{
						stroke: textMuted,
						grid: { stroke: border },
						splits: (u) => tickIndices(u.width, labels),
						values: (_u, splits) => splits.map((s) => formatShortDate(labels[s] ?? "")),
					},
					{ stroke: textMuted, grid: { stroke: border } },
				],
			};
		};
	}, [labels]);

	if (
		data.length === 0 ||
		data.every((d) => d.backlogTodo + d.inProgress + d.inReview + d.done === 0)
	) {
		return <EmptyChartState message="No issues in this window yet" />;
	}

	return <UplotChart data={chartData} buildOptions={buildOptions} />;
}
