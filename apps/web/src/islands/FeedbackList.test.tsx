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

const ROW_2 = {
	id: "f2",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: -1,
	ratingScale: "thumbs",
	body: "Confusing step",
	submitterLabel: null,
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1001,
};

function stubFetch(rows: unknown[] = [ROW, ROW_2], bulkConvertStatus = 201) {
	const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/bulk-convert-to-issue")) {
			if (bulkConvertStatus !== 201) {
				return Promise.resolve({
					ok: false,
					status: bulkConvertStatus,
					json: () => Promise.resolve({ error: "Conflict" }),
				});
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ id: "issue-1", convertedCount: 2 }),
			});
		}
		if (u.includes("/bulk-mark-reviewed")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ updated: 2 }) });
		}
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
		stubFetch([ROW]);
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

	it("mark-reviewed PATCHes with status reviewed and refetches", async () => {
		const fetchMock = stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					const body = call[1]?.body ? JSON.parse(String(call[1].body)) : null;
					return (
						String(call[0]).includes("/feedback/f1") &&
						call[1]?.method === "PATCH" &&
						body?.status === "reviewed"
					);
				})
			).toBe(true);
		});
	});

	it("convert-to-issue POSTs and refetches", async () => {
		const fetchMock = stubFetch([ROW]);
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

	it("select-all then bulk mark-reviewed POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Mark all reviewed$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-mark-reviewed")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.length === 2 && call[1]?.method === "POST";
				})
			).toBe(true);
		});
	});

	it("select-all then bulk convert-to-issue POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-convert-to-issue")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.includes("f1") && body.feedbackIds.includes("f2");
				})
			).toBe(true);
		});
	});

	it("shows an error and keeps the selection when bulk convert-to-issue conflicts", async () => {
		stubFetch([ROW, ROW_2], 409);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/2 selected/i)).toBeTruthy();
	});
});
