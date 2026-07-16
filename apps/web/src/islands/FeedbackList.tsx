import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface Feedback {
	id: string;
	sourceId: string;
	sourceName: string | null;
	rating: number | null;
	ratingScale: string | null;
	body: string | null;
	submitterLabel: string | null;
	sourceUrl: string | null;
	appVersion: string | null;
	status: string;
	linkedIssueId: string | null;
	createdAt: number;
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
}

const TD = "px-3 py-2 border-b border-border align-top text-[0.875rem]";
const TH =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function ratingDisplay(rating: number | null, scale: string | null): string {
	if (rating === null) return "—";
	if (scale === "thumbs") return rating > 0 ? "👍" : "👎";
	return "★".repeat(Math.max(0, Math.min(5, rating)));
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

export default function FeedbackList({ workspaceSlug, projectId }: Props) {
	const [rows, setRows] = useState<Feedback[]>([]);
	const [status, setStatus] = useState("");
	const [sourceFilter, setSourceFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchRows = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams();
			if (status) params.set("status", status);
			if (sourceFilter) params.set("sourceId", sourceFilter);
			const qs = params.toString();
			const data = await apiFetch<Feedback[]>(
				`/api/projects/${projectId}/feedback${qs ? `?${qs}` : ""}`,
				{ workspaceSlug }
			);
			setRows(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, status, sourceFilter, workspaceSlug]);

	useEffect(() => {
		fetchRows();
	}, [fetchRows]);

	async function convert(id: string) {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/${id}/convert-to-issue`, {
				method: "POST",
				workspaceSlug,
			});
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function markReviewed(id: string) {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/${id}`, {
				method: "PATCH",
				body: { status: "reviewed" },
				workspaceSlug,
			});
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	const sourceOptions = Array.from(
		new Map(rows.filter((r) => r.sourceName).map((r) => [r.sourceId, r.sourceName])).entries()
	);

	return (
		<section>
			<div class="flex gap-4 items-end mb-4">
				<div class="flex flex-col gap-1">
					<label class="text-[0.8rem] font-semibold text-text-muted" for="fb-status">
						Status
					</label>
					<select
						id="fb-status"
						class="px-2 py-1 border border-border rounded bg-bg text-text-base text-sm"
						value={status}
						onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
					>
						<option value="">All</option>
						<option value="new">New</option>
						<option value="reviewed">Reviewed</option>
						<option value="actioned">Actioned</option>
					</select>
				</div>
				{sourceOptions.length > 1 && (
					<div class="flex flex-col gap-1">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fb-source">
							Source
						</label>
						<select
							id="fb-source"
							class="px-2 py-1 border border-border rounded bg-bg text-text-base text-sm"
							value={sourceFilter}
							onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value)}
						>
							<option value="">All sources</option>
							{sourceOptions.map(([id, name]) => (
								<option key={id} value={id}>
									{name}
								</option>
							))}
						</select>
					</div>
				)}
			</div>

			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}
			{loading ? (
				<p aria-live="polite">Loading feedback…</p>
			) : rows.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback yet.
				</div>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr>
								<th class={TH}>Rating</th>
								<th class={TH}>Feedback</th>
								<th class={TH}>Source</th>
								<th class={TH}>Status</th>
								<th class={TH}>Received</th>
								<th class={TH}></th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id}>
									<td class={TD}>{ratingDisplay(r.rating, r.ratingScale)}</td>
									<td class={`${TD} text-text-base`}>
										<div>{r.body ?? "—"}</div>
										{r.submitterLabel && (
											<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
										)}
									</td>
									<td class={`${TD} text-text-muted`}>{r.sourceName ?? "—"}</td>
									<td class={`${TD} text-text-muted`}>{r.status}</td>
									<td class={`${TD} text-text-muted`}>{formatDate(r.createdAt)}</td>
									<td class={`${TD} whitespace-nowrap`}>
										<div class="flex gap-2">
											{r.status === "new" && (
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => markReviewed(r.id)}
												>
													Mark reviewed
												</button>
											)}
											{r.linkedIssueId ? (
												<span class="text-[0.8rem] text-text-muted">Linked</span>
											) : (
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => convert(r.id)}
												>
													Convert to issue
												</button>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
