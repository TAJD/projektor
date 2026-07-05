import { formatIssueRef } from "../../lib/issue-ref";
import { issueUrl } from "../../utils/issue-url";
import type { SearchResult } from "./useIssueSearch";

function SearchResultsTable({ results }: { results: SearchResult[] }) {
	return (
		<div class="overflow-x-auto max-sm:hidden">
			<table class="w-full border-collapse text-[0.9rem]">
				<thead>
					<tr class="bg-surface">
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
							#
						</th>
						<th class="text-left px-3 py-2 border-b-2 border-border font-semibold w-full text-text-base">Title</th>
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
								<span class="text-text-muted font-mono text-[0.8rem]">{formatIssueRef(r.project_key, r.number)}</span>
							</td>
							<td class="px-3 py-2 align-middle text-text-base">
								<a
									href={issueUrl(r.project_key, r.number, r.title, r.id)}
									class="text-text-base no-underline hover:underline focus:underline"
								>
									{r.title}
								</a>
							</td>
							<td class="px-3 py-2 align-middle whitespace-nowrap">
								<span
									class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize whitespace-nowrap"
									style={{
										background: `var(--priority-${r.priority}-bg, var(--priority-low-bg))`,
										color: `var(--priority-${r.priority}-text, var(--text-muted))`,
									}}
								>
									{r.priority === "none" ? "–" : r.priority}
								</span>
							</td>
							<td class="px-3 py-2 align-middle whitespace-nowrap">
								<span class="font-medium text-sm text-text-muted">{r.status.replace(/_/g, " ")}</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
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
	return <SearchResultsTable results={searchResults} />;
}
