import { formatIssueRef } from "../../lib/issue-ref";
import { issueUrl } from "../../utils/issue-url";
import type { SearchResult } from "./useIssueSearch";

function priorityBadge(r: SearchResult) {
	return (
		<span
			class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize whitespace-nowrap"
			style={{
				background: `var(--priority-${r.priority}-bg, var(--priority-low-bg))`,
				color: `var(--priority-${r.priority}-text, var(--text-muted))`,
			}}
		>
			{r.priority === "none" ? "–" : r.priority}
		</span>
	);
}

function statusBadge(r: SearchResult) {
	return <span class="font-medium text-sm text-text-muted">{r.status.replace(/_/g, " ")}</span>;
}

function SearchResultsTable({ results }: { results: SearchResult[] }) {
	return (
		<div class="overflow-x-auto max-sm:hidden">
			<table class="w-full border-collapse text-[0.9rem]">
				<thead>
					<tr class="bg-surface">
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
							#
						</th>
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold w-full text-text-base">
							Title
						</th>
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
							Priority
						</th>
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
							Status
						</th>
					</tr>
				</thead>
				<tbody>
					{results.map((r) => (
						<tr key={r.id} class="border-b border-border">
							<td class="px-3 py-2 align-middle whitespace-nowrap">
								<span class="text-text-muted font-mono text-[0.8rem]">
									{formatIssueRef(r.project_key, r.number)}
								</span>
							</td>
							<td class="px-3 py-2 align-middle text-text-base">
								<a
									href={issueUrl(r.project_key, r.number, r.title, r.id)}
									class="text-text-base no-underline hover:underline focus:underline"
								>
									{r.title}
								</a>
							</td>
							<td class="px-3 py-2 align-middle whitespace-nowrap">{priorityBadge(r)}</td>
							<td class="px-3 py-2 align-middle whitespace-nowrap">{statusBadge(r)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function SearchResultsMobileCards({ results }: { results: SearchResult[] }) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{results.map((r) => (
				<div key={r.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<span class="inline-block font-mono text-[0.8rem] text-text-muted mb-1">
						{formatIssueRef(r.project_key, r.number)}
					</span>
					<a href={issueUrl(r.project_key, r.number, r.title, r.id)} class="no-underline">
						<div class="text-[0.9rem] text-text-base font-medium mb-2">{r.title}</div>
					</a>
					<div class="flex gap-[0.375rem] flex-wrap items-center">
						{priorityBadge(r)}
						{statusBadge(r)}
					</div>
				</div>
			))}
		</div>
	);
}

export default function SearchResultsSection({
	searchLoading,
	searchResults,
	searchQuery,
}: {
	searchLoading: boolean;
	searchResults: SearchResult[] | null;
	searchQuery: string;
}) {
	if (searchLoading) {
		return (
			<p aria-live="polite" class="text-text-muted">
				Searching…
			</p>
		);
	}
	if (searchResults === null) return null;
	if (searchResults.length === 0) {
		return <p class="text-text-muted">No results for «{searchQuery.trim()}»</p>;
	}
	return (
		<>
			<SearchResultsTable results={searchResults} />
			<SearchResultsMobileCards results={searchResults} />
		</>
	);
}
