import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceGrid from "./FeedbackSourceGrid";

const ACTIVE_SOURCE = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

const REVOKED_SOURCE = {
	id: "s2",
	name: "Old widget",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "ffffff000000…",
	createdAt: 900,
	revokedAt: 2000,
};

const SUMMARY = [
	{
		sourceId: "s1",
		sourceName: "Onboarding survey",
		totalCount: 5,
		versions: [
			{
				appVersion: "v1",
				totalCount: 5,
				withCommentCount: 1,
				thumbsUpPct: 80,
				avgFiveStar: null,
				lastSeenAt: 5000,
			},
		],
	},
];

function stubFetch(sources = [ACTIVE_SOURCE, REVOKED_SOURCE], summary = SUMMARY) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/feedback/summary")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(summary) });
			}
			if (u.includes("/feedback-sources")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		})
	);
}

describe("FeedbackSourceGrid", () => {
	it("renders a card per source with volume and status, plus a New source card", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Onboarding survey")).toBeTruthy();
		expect(screen.getByText("5 total")).toBeTruthy();
		expect(screen.getByText("Old widget")).toBeTruthy();
		expect(screen.getByText("No feedback yet")).toBeTruthy();
		expect(screen.getByRole("button", { name: /New source/i })).toBeTruthy();
	});

	it("links each card to its detail page", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		const link = (await screen.findByText("Onboarding survey")).closest("a");
		expect(link?.getAttribute("href")).toBe("/feedback/s1");
	});

	it("marks a revoked source as Revoked", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Old widget");
		expect(screen.getByText("Revoked")).toBeTruthy();
	});

	it("opens the New source modal on click", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Onboarding survey");
		fireEvent.click(screen.getByRole("button", { name: /New source/i }));
		expect(screen.getByRole("dialog", { name: /New feedback source/i })).toBeTruthy();
	});

	it("keeps the New source modal (and its one-time token) mounted through the post-create refetch", async () => {
		stubFetch([]);
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByRole("button", { name: /New source/i });
		fireEvent.click(screen.getByRole("button", { name: /New source/i }));

		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				const u = String(url);
				if (opts?.method === "POST" && u.includes("/feedback-sources")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ id: "s3", token: "raw-token-value" }),
					});
				}
				if (u.includes("/feedback/summary")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				if (u.includes("/feedback-sources")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([ACTIVE_SOURCE]) });
				}
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			})
		);

		fireEvent.input(screen.getByLabelText("Name *"), { target: { value: "New source" } });
		fireEvent.click(screen.getByRole("button", { name: "Create source" }));

		expect(await screen.findByText("raw-token-value")).toBeTruthy();
		await screen.findByText("Onboarding survey");
		expect(screen.getByText("raw-token-value")).toBeTruthy();
	});

	it("renders an access-denied notice on a 403 list response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
				)
		);
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText(/Only workspace owners and admins/i)).toBeTruthy();
	});
});
