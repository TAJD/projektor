// SearchResultsSection — mobile viewport test (PROJ-412).
//
// Below 640px the desktop table (`max-sm:hidden`) renders nothing, so a
// mobile-card fallback must render whenever there are results. Only the
// mobile-card presence is JS-visible in jsdom (see apps/web/src/test/viewport.ts) -
// the `max-sm:hidden`/`max-sm:flex` CSS itself isn't evaluated here.
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { MOBILE_WIDTH, setViewportWidth } from "../../test/viewport";
import SearchResultsSection from "./SearchResultsSection";
import type { SearchResult } from "./useIssueSearch";

const RESULTS: SearchResult[] = [
	{
		id: "i1",
		number: 1,
		title: "Fix the thing",
		status: "in_progress",
		priority: "high",
		project_id: "p1",
		project_key: "PROJ",
		project_name: "Projektor",
	},
];

describe("SearchResultsSection — mobile viewport", () => {
	it("renders mobile cards for non-empty results at narrow widths", () => {
		setViewportWidth(MOBILE_WIDTH);
		render(
			<SearchResultsSection searchLoading={false} searchResults={RESULTS} searchQuery="fix" />
		);

		expect(screen.getAllByText("Fix the thing")).toHaveLength(2);
	});

	it("shows the loading state regardless of viewport", () => {
		setViewportWidth(MOBILE_WIDTH);
		render(<SearchResultsSection searchLoading={true} searchResults={null} searchQuery="fix" />);

		expect(screen.getByText("Searching…")).toBeTruthy();
	});

	it("shows the no-results state regardless of viewport", () => {
		setViewportWidth(MOBILE_WIDTH);
		render(<SearchResultsSection searchLoading={false} searchResults={[]} searchQuery="fix" />);

		expect(screen.getByText("No results for «fix»")).toBeTruthy();
	});
});
