import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_WIDTH, setViewportWidth } from "../test/viewport";
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

// Table interactions are scoped to the desktop table via `within`, since the
// mobile-card fallback (PROJ-415) renders the same controls a second time —
// both are always in the DOM, CSS picks which is visible per viewport (jsdom
// doesn't evaluate CSS, see apps/web/src/test/viewport.ts).
function table() {
	return within(screen.getByRole("table"));
}

describe("FeedbackList", () => {
	it("renders feedback rows with body and source name", async () => {
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		expect((await screen.findAllByText("Great onboarding")).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Onboarding survey/).length).toBeGreaterThan(0);
	});

	it("changing the status filter refetches with the status query param", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findAllByText("Great onboarding");
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
		await screen.findAllByText("Great onboarding");
		fireEvent.click(table().getByRole("button", { name: /Mark reviewed/i }));
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
		await screen.findAllByText("Great onboarding");
		fireEvent.click(table().getByRole("button", { name: /Convert to issue/i }));
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
		await screen.findAllByText("Great onboarding");
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
		await screen.findAllByText("Great onboarding");
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
		await screen.findAllByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/2 selected/i)).toBeTruthy();
	});
});

describe("FeedbackList — mobile viewport", () => {
	it("renders a mobile-card fallback alongside the desktop table", async () => {
		setViewportWidth(MOBILE_WIDTH);
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		// Desktop table + mobile card both render (CSS hides one per viewport).
		expect((await screen.findAllByText("Great onboarding")).length).toBe(2);
	});
});

const ROW_WITH_CONTEXT = {
	...ROW,
	id: "f3",
	sourceUrl: "https://ironvolume.example.com/wod?seed=abc123&focus=strength",
};

const ROW_BARE_URL = {
	...ROW,
	id: "f4",
	sourceUrl: "https://ironvolume.example.com/wod",
};

const ROW_MALFORMED_URL = {
	...ROW,
	id: "f5",
	sourceUrl: "not a url",
};

const ROW_JS_URL = {
	...ROW,
	id: "f6",
	sourceUrl: "javascript:alert(1)",
};

describe("FeedbackList structured context", () => {
	it("shows a Context toggle with the param count and expands to reveal params + raw link", async () => {
		stubFetch([ROW_WITH_CONTEXT]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findAllByText("Great onboarding");
		const toggle = table().getByRole("button", { name: /Context \(2\)/i });
		expect(screen.queryByText(/seed:/i)).toBeNull();
		fireEvent.click(toggle);
		expect(table().getByText(/seed:\s*abc123/i)).toBeTruthy();
		expect(table().getByText(/focus:\s*strength/i)).toBeTruthy();
		expect(table().getByRole("link", { name: ROW_WITH_CONTEXT.sourceUrl })).toBeTruthy();
	});

	it("shows a Context (0) toggle for a sourceUrl with no query string, expanding to just the raw link", async () => {
		stubFetch([ROW_BARE_URL]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findAllByText("Great onboarding");
		const toggle = table().getByRole("button", { name: /Context \(0\)/i });
		fireEvent.click(toggle);
		expect(table().getByRole("link", { name: ROW_BARE_URL.sourceUrl })).toBeTruthy();
	});

	it("renders no Context toggle when sourceUrl is null", async () => {
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});

	it("renders no Context toggle for a malformed sourceUrl, without throwing", async () => {
		stubFetch([ROW_MALFORMED_URL]);
		expect(() => render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />)).not.toThrow();
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});

	it("renders no Context toggle for a javascript: sourceUrl, without throwing", async () => {
		stubFetch([ROW_JS_URL]);
		expect(() => render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />)).not.toThrow();
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});
});
