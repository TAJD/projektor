import { useEffect, useState } from "preact/hooks";
import uPlot from "uplot";
import { apiFetch } from "../utils/api-client";
import UplotChart from "./charts/UplotChart";

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
	agentVsHuman: { agent: Distribution; human: Distribution };
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

function ThroughputChart({ data }: { data: FlowMetrics["throughputOverTime"] }) {
	if (data.length === 0) {
		return <p class="text-sm text-text-muted m-0">No completed issues in this window yet.</p>;
	}

	const labels = data.map((d) => d.weekStart);
	const xs = data.map((_, i) => i);
	const ys = data.map((d) => d.count);

	return (
		<UplotChart
			data={[xs, ys]}
			options={{
				width: 600,
				height: 220,
				scales: { x: { time: false } },
				series: [
					{},
					{
						label: "Issues completed",
						stroke: "rgba(37,99,235,0.8)",
						fill: "rgba(37,99,235,0.25)",
						paths: uPlot.paths.bars?.(),
					},
				],
				axes: [
					{
						values: (_u, splits) => splits.map((s) => labels[s] ?? ""),
					},
					{},
				],
			}}
		/>
	);
}

function WipChart({ data }: { data: FlowMetrics["wipOverTime"] }) {
	if (data.length === 0) {
		return <p class="text-sm text-text-muted m-0">No WIP data in this window yet.</p>;
	}

	const xs = data.map((d) => Math.floor(new Date(d.date).getTime() / 1000));
	const ys = data.map((d) => d.count);

	return (
		<UplotChart
			data={[xs, ys]}
			options={{
				width: 600,
				height: 220,
				scales: { x: { time: true } },
				series: [{}, { label: "WIP", stroke: "rgba(22,163,74,0.8)", width: 2 }],
			}}
		/>
	);
}

function AgentVsHumanTiles({ agentVsHuman }: { agentVsHuman: FlowMetrics["agentVsHuman"] }) {
	return (
		<div class="mb-8">
			<h2 class="m-0 mb-3 text-base font-semibold text-text-base">Agent vs human</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<div class="px-4 py-3 bg-surface border border-border rounded-lg">
					<p class="m-0 mb-2 text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
						Agent
					</p>
					<div class="grid grid-cols-3 gap-2 text-sm">
						<span>Count: {agentVsHuman.agent.count}</span>
						<span>Avg: {formatDuration(agentVsHuman.agent.avg)}</span>
						<span>p90: {formatDuration(agentVsHuman.agent.p90)}</span>
					</div>
				</div>
				<div class="px-4 py-3 bg-surface border border-border rounded-lg">
					<p class="m-0 mb-2 text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
						Human
					</p>
					<div class="grid grid-cols-3 gap-2 text-sm">
						<span>Count: {agentVsHuman.human.count}</span>
						<span>Avg: {formatDuration(agentVsHuman.human.avg)}</span>
						<span>p90: {formatDuration(agentVsHuman.human.p90)}</span>
					</div>
				</div>
			</div>
		</div>
	);
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

			<AgentVsHumanTiles agentVsHuman={metrics.agentVsHuman} />
		</div>
	);
}
