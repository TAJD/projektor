import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackList from "./FeedbackList";

const ROW = {
	id: "f1",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: 5,
	ratingScale: "five_star",
	body: "Great onboarding",
	submitterLabel: "a@b.com",
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1000,
};

function stubFetch(rows = [ROW]) {
	const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/convert-to-issue")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "issue-1" }) });
		}
		if (u.includes("/feedback")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackList", () => {
	it("renders feedback rows with body and source name", async () => {
		stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Great onboarding")).toBeTruthy();
		expect(screen.getByText(/Onboarding survey/)).toBeTruthy();
	});

	it("changing the status filter refetches with the status query param", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "reviewed" } });
		await waitFor(() => {
			expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("status=reviewed"))).toBe(
				true
			);
		});
	});

	it("convert-to-issue POSTs and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByRole("button", { name: /Convert to issue/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					(call) => String(call[0]).includes("/convert-to-issue") && call[1]?.method === "POST"
				)
			).toBe(true);
		});
	});
});
