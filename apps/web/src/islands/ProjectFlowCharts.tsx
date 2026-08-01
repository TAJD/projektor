import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import {
	CfdChart,
	type CfdPoint,
	ThroughputChart,
	type ThroughputPoint,
} from "./metrics/flow-charts";

interface FlowMetrics {
	throughputOverTime: ThroughputPoint[];
	cfdOverTime: CfdPoint[];
}

const SECTION_HEADING_CLASS =
	"text-xs font-semibold text-text-muted m-0 mb-3 uppercase tracking-[0.05em]";

function mondayOfWeek(d: Date): Date {
	const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
	monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
	return monday;
}

// Same 6-week weekly default window as MetricsDashboard's defaultRange, so a project's
// overview and its full /metrics page agree on "recent" without a picker on this page.
// `until` matches MetricsDashboard's dateStrToEpochEnd (end of today, UTC) rather than
// `Date.now() + 86399`, which would reach ~24h into tomorrow.
function defaultSinceUntil(): { since: number; until: number } {
	const today = new Date();
	const monday = mondayOfWeek(today);
	monday.setUTCDate(monday.getUTCDate() - 5 * 7);
	const since = Math.floor(monday.getTime() / 1000);
	const todayUtcMidnight = Date.UTC(
		today.getUTCFullYear(),
		today.getUTCMonth(),
		today.getUTCDate()
	);
	const until = Math.floor(todayUtcMidnight / 1000) + 86399;
	return { since, until };
}

function useProjectFlowCharts(workspaceSlug: string | undefined, projectId: string | null) {
	const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!projectId) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		const { since, until } = defaultSinceUntil();
		const query = new URLSearchParams({
			since: String(since),
			until: String(until),
			granularity: "week",
		});
		apiFetch<FlowMetrics>(`/api/projects/${encodeURIComponent(projectId)}/flow-metrics?${query}`, {
			workspaceSlug,
		})
			.then((data) => setMetrics(data))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [projectId, workspaceSlug]);

	// cofferdam-ignore: Consistency.ErrorHandlingIdiom: hook returns {data,error,loading} state, standard in this codebase
	return { metrics, loading, error };
}

export default function ProjectFlowCharts({
	workspaceSlug,
	projectId,
}: {
	workspaceSlug: string | undefined;
	projectId: string;
}) {
	const { metrics, loading, error } = useProjectFlowCharts(workspaceSlug, projectId);

	if (loading) return null;
	if (error || !metrics) return null;

	return (
		<section class="mb-8" aria-labelledby="flow-charts-heading">
			<h2 id="flow-charts-heading" class={SECTION_HEADING_CLASS}>
				Flow (last 6 weeks)
			</h2>
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
					<p class="m-0 mb-2 text-[0.72rem] font-medium text-text-muted">Throughput</p>
					<ThroughputChart data={metrics.throughputOverTime ?? []} />
				</div>
				<div class="p-4 bg-surface border border-border rounded-lg overflow-x-auto">
					<p class="m-0 mb-2 text-[0.72rem] font-medium text-text-muted">Cumulative flow</p>
					<CfdChart data={metrics.cfdOverTime ?? []} />
				</div>
			</div>
		</section>
	);
}
