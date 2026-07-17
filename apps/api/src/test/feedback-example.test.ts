import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitFeedback } from "../examples/feedback-widget-submit";
import { authHeaders, seedProjectFixture } from "./helpers";

// Proves the exact code shown in the feedback-widget-integration docs guide
// (mirrored from ../examples/feedback-widget-submit.ts, see that file's header)
// actually works end-to-end, not just that the API contract it targets does.
describe("documented feedback widget example", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("submitFeedback() from the docs example submits to a live feedback source", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ name: "Docs example source" }),
			}
		);
		const { token } = (await created.json()) as { token: string };

		// The example calls the ambient global `fetch`, exactly as it would in a
		// browser; stub it to dispatch into the worker under test instead of the
		// real network.
		vi.stubGlobal("fetch", (url: string, init?: RequestInit) => SELF.fetch(url, init));

		const result = await submitFeedback("http://localhost/api/feedback/submit", token, {
			rating: 1,
			ratingScale: "thumbs",
			body: "Docs example works",
		});
		expect(result.id).toBeTruthy();

		const row = await env.DB.prepare("SELECT body, rating FROM feedback WHERE id = ?")
			.bind(result.id)
			.first<{ body: string; rating: number }>();
		expect(row?.body).toBe("Docs example works");
		expect(row?.rating).toBe(1);
	});

	it("submitFeedback() surfaces a thrown error on rejection (e.g. bad token)", async () => {
		vi.stubGlobal("fetch", (url: string, init?: RequestInit) => SELF.fetch(url, init));

		await expect(
			submitFeedback("http://localhost/api/feedback/submit", "not-a-real-token", { body: "x" })
		).rejects.toThrow(/Feedback submit failed: 401/);
	});
});
