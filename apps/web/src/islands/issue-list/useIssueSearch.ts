import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";

export interface SearchResult {
	id: string;
	number: number;
	title: string;
	status: string;
	priority: string;
	project_id: string | null;
	project_key: string | null;
	project_name: string | null;
}

/** Debounced issue search (PROJ-110), isolated from the parent list's fetch/filter state. */
export function useIssueSearch(workspaceSlug: string | undefined) {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
	const [searchLoading, setSearchLoading] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const q = searchQuery.trim();
		if (!q) {
			setSearchResults(null);
			setSearchLoading(false);
			return;
		}
		setSearchLoading(true);
		const timer = setTimeout(async () => {
			try {
				const params = new URLSearchParams({ q });
				const data = await apiFetch<SearchResult[]>(`/api/issues/search?${params}`, {
					workspaceSlug,
				});
				setSearchResults(Array.isArray(data) ? data : []);
			} catch {
				setSearchResults([]);
			} finally {
				setSearchLoading(false);
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery, workspaceSlug]);

	const isSearchActive = searchQuery.trim().length > 0;

	return {
		searchQuery,
		setSearchQuery,
		searchResults,
		searchLoading,
		searchInputRef,
		isSearchActive,
	};
}
