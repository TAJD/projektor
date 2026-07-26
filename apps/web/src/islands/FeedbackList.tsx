import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import Select from "./Select";

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
	sourceId: string;
}

const STATUS_OPTIONS = [
	{ value: "", label: "All" },
	{ value: "new", label: "New" },
	{ value: "reviewed", label: "Reviewed" },
	{ value: "actioned", label: "Actioned" },
];

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

function parseContext(
	sourceUrl: string | null
): { url: string; params: [string, string][] } | null {
	if (!sourceUrl) return null;
	try {
		const parsed = new URL(sourceUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return { url: sourceUrl, params: Array.from(parsed.searchParams.entries()) };
	} catch {
		return null;
	}
}

function FeedbackContext({
	row,
	expanded,
	onToggle,
}: {
	row: Feedback;
	expanded: boolean;
	onToggle: () => void;
}) {
	const context = parseContext(row.sourceUrl);
	if (!context) return null;
	return (
		<div class="mt-1">
			<button type="button" class="text-[0.75rem] text-text-muted underline" onClick={onToggle}>
				Context ({context.params.length})
			</button>
			{expanded && (
				<div class="text-[0.75rem] text-text-muted mt-1 flex flex-col gap-0.5">
					<a href={context.url} target="_blank" rel="noopener noreferrer" class="underline">
						{context.url}
					</a>
					{context.params.map(([key, value]) => (
						<div key={key}>
							{key}: {value}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function FeedbackRowActions({
	row,
	onMarkReviewed,
	onConvert,
}: {
	row: Feedback;
	onMarkReviewed: (id: string) => void;
	onConvert: (id: string) => void;
}) {
	return (
		<div class="flex gap-2 flex-wrap">
			{row.status === "new" && (
				<button type="button" class="btn btn-outline btn-sm" onClick={() => onMarkReviewed(row.id)}>
					Mark reviewed
				</button>
			)}
			{row.linkedIssueId ? (
				<span class="text-[0.8rem] text-text-muted">Linked</span>
			) : (
				<button type="button" class="btn btn-outline btn-sm" onClick={() => onConvert(row.id)}>
					Convert to issue
				</button>
			)}
		</div>
	);
}

interface FeedbackMobileCardsProps {
	rows: Feedback[];
	selected: Set<string>;
	expanded: Set<string>;
	onToggleRow: (id: string) => void;
	onToggleExpanded: (id: string) => void;
	onMarkReviewed: (id: string) => void;
	onConvert: (id: string) => void;
}

function FeedbackMobileCards({
	rows,
	selected,
	expanded,
	onToggleRow,
	onToggleExpanded,
	onMarkReviewed,
	onConvert,
}: FeedbackMobileCardsProps) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{rows.map((r) => (
				<div key={r.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="flex items-start gap-2 mb-2">
						<input
							type="checkbox"
							aria-label={`select row ${r.id}`}
							checked={selected.has(r.id)}
							onChange={() => onToggleRow(r.id)}
							class="mt-1"
						/>
						<div class="flex-1">
							<div class="flex justify-between items-center gap-2 mb-1">
								<span class="text-[0.9rem]">{ratingDisplay(r.rating, r.ratingScale)}</span>
								<span class="text-[0.75rem] text-text-muted">{formatDate(r.createdAt)}</span>
							</div>
							<div class="text-[0.875rem] text-text-base">{r.body ?? "—"}</div>
							{r.submitterLabel && (
								<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
							)}
							<FeedbackContext
								row={r}
								expanded={expanded.has(r.id)}
								onToggle={() => onToggleExpanded(r.id)}
							/>
							<div class="text-[0.75rem] text-text-muted mt-1">{r.status}</div>
						</div>
					</div>
					<FeedbackRowActions row={r} onMarkReviewed={onMarkReviewed} onConvert={onConvert} />
				</div>
			))}
		</div>
	);
}

export default function FeedbackList({ workspaceSlug, projectId, sourceId }: Props) {
	const [rows, setRows] = useState<Feedback[]>([]);
	const [status, setStatus] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const fetchRows = useCallback(async () => {
		if (!projectId || !sourceId) return;
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams({ sourceId });
			if (status) params.set("status", status);
			const data = await apiFetch<Feedback[]>(
				`/api/projects/${projectId}/feedback?${params.toString()}`,
				{ workspaceSlug }
			);
			setRows(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, sourceId, status, workspaceSlug]);

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

	async function bulkMarkReviewed() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-mark-reviewed`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function bulkConvertToIssue() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-convert-to-issue`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	function toggleSelectAll() {
		setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
	}

	function toggleRow(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleExpanded(id: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	return (
		<section>
			<div class="flex gap-4 items-end mb-4">
				<div class="flex flex-col gap-1">
					<span class="text-[0.8rem] font-semibold text-text-muted">Status</span>
					<Select
						ariaLabel="Status"
						value={status}
						onChange={(v) => {
							setStatus(v);
							setSelected(new Set());
						}}
						options={STATUS_OPTIONS}
					/>
				</div>
			</div>

			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}
			{selected.size > 0 && (
				<div class="flex gap-2 items-center mb-3 p-2 bg-surface border border-border rounded">
					<span class="text-[0.85rem] text-text-muted">{selected.size} selected</span>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkMarkReviewed}>
						Mark all reviewed
					</button>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkConvertToIssue}>
						Convert all to issue
					</button>
				</div>
			)}
			{loading ? (
				<p aria-live="polite">Loading feedback…</p>
			) : rows.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback yet.
				</div>
			) : (
				<>
					<div class="overflow-x-auto max-sm:hidden">
						<table class="w-full border-collapse text-[0.9rem]">
							<thead>
								<tr>
									<th class={TH}>
										<input
											type="checkbox"
											aria-label="select all"
											checked={rows.length > 0 && selected.size === rows.length}
											onChange={toggleSelectAll}
										/>
									</th>
									<th class={TH}>Rating</th>
									<th class={TH}>Feedback</th>
									<th class={TH}>Status</th>
									<th class={TH}>Received</th>
									<th class={TH}></th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr key={r.id}>
										<td class={TD}>
											<input
												type="checkbox"
												aria-label={`select row ${r.id}`}
												checked={selected.has(r.id)}
												onChange={() => toggleRow(r.id)}
											/>
										</td>
										<td class={TD}>{ratingDisplay(r.rating, r.ratingScale)}</td>
										<td class={`${TD} text-text-base`}>
											<div>{r.body ?? "—"}</div>
											{r.submitterLabel && (
												<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
											)}
											<FeedbackContext
												row={r}
												expanded={expanded.has(r.id)}
												onToggle={() => toggleExpanded(r.id)}
											/>
										</td>
										<td class={`${TD} text-text-muted`}>{r.status}</td>
										<td class={`${TD} text-text-muted`}>{formatDate(r.createdAt)}</td>
										<td class={`${TD} whitespace-nowrap`}>
											<FeedbackRowActions
												row={r}
												onMarkReviewed={markReviewed}
												onConvert={convert}
											/>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<FeedbackMobileCards
						rows={rows}
						selected={selected}
						expanded={expanded}
						onToggleRow={toggleRow}
						onToggleExpanded={toggleExpanded}
						onMarkReviewed={markReviewed}
						onConvert={convert}
					/>
				</>
			)}
		</section>
	);
}
