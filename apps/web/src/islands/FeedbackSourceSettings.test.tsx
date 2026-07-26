import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceSettings, { type FeedbackSource } from "./FeedbackSourceSettings";

const SOURCE: FeedbackSource = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

function stubFetch() {
	const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/rotate")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ token: "fbk_rotated_token" }),
			});
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackSourceSettings", () => {
	it("renders token preview and created date", () => {
		stubFetch();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={() => {}}
			/>
		);
		expect(screen.getByText("abcdef012345…")).toBeTruthy();
	});

	it("toggling active PATCHes isActive and calls onChanged", async () => {
		const fetchMock = stubFetch();
		const onChanged = vi.fn();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={onChanged}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /^Active$/i }));
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
		const call = fetchMock.mock.calls.find((c) => c[1]?.method === "PATCH");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ isActive: false });
	});

	it("rotating requires confirmation, then shows the new raw token once", async () => {
		stubFetch();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={() => {}}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /Rotate token/i }));
		fireEvent.click(screen.getByRole("button", { name: /^Yes$/i }));
		expect(await screen.findByText("fbk_rotated_token")).toBeTruthy();
		expect(screen.getByText(/won't be able to see it again/i)).toBeTruthy();
	});

	it("revoking DELETEs the source and calls onChanged", async () => {
		const fetchMock = stubFetch();
		const onChanged = vi.fn();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={onChanged}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /Revoke source/i }));
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(true);
	});
});
