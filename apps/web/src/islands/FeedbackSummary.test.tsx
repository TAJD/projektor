import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSummary from "./FeedbackSummary";

const SUMMARY = [
	{
		sourceId: "s1",
		sourceName: "Onboarding survey",
		totalCount: 3,
		versions: [
			{
				appVersion: "v1.1.0",
				totalCount: 2,
				withCommentCount: 1,
				thumbsUpPct: null,
				avgFiveStar: 4.5,
				lastSeenAt: 200,
			},
			{
				appVersion: null,
				totalCount: 1,
				withCommentCount: 0,
				thumbsUpPct: 100,
				avgFiveStar: null,
				lastSeenAt: 100,
			},
		],
	},
];

function stubFetch(data: unknown = SUMMARY) {
	const fetchMock = vi
		.fn()
		.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve(data) }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackSummary", () => {
	it("renders a card per source with total count", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Onboarding survey")).toBeTruthy();
		expect(screen.getByText(/3 total/i)).toBeTruthy();
	});

	it("renders avg star rating and comment count for a version", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Onboarding survey");
		expect(screen.getByText(/v1\.1\.0/)).toBeTruthy();
		expect(screen.getByText(/4\.5★ avg/)).toBeTruthy();
		expect(screen.getByText(/1 with comments/)).toBeTruthy();
	});

	it("renders thumbs-up % and falls back to 'Unknown version' for a null appVersion", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Onboarding survey");
		expect(screen.getByText(/Unknown version/i)).toBeTruthy();
		expect(screen.getByText(/👍 100%/)).toBeTruthy();
	});

	it("shows an empty state when there is no feedback yet", async () => {
		stubFetch([]);
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText(/No feedback yet/i)).toBeTruthy();
	});
});
