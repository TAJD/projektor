import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("returns 200 ok", async () => {
		const res = await SELF.fetch("http://localhost/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});

	it("is also reachable under /api/health (open, no auth)", async () => {
		const res = await SELF.fetch("http://localhost/api/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("auth middleware", () => {
	it("rejects requests with no Authorization header", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: { "X-Workspace-Slug": "anything" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with a bad token", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				Authorization: "Bearer not-a-real-token",
				"X-Workspace-Slug": "anything",
			},
		});
		expect(res.status).toBe(401);
	});
});

// ─── SPA catch-all ────────────────────────────────────────────────────────────
// ASSETS binding is absent in the test environment, so the catch-all returns 404.
// These tests verify: (a) API routes are unaffected, (b) unmatched paths hit the
// catch-all and 404, (c) issue pretty-URL paths also hit the catch-all and 404.

describe("SPA catch-all (ASSETS absent in test env)", () => {
	it("returns 404 for unmatched non-API paths", async () => {
		const res = await SELF.fetch("http://localhost/some-random-path");
		expect(res.status).toBe(404);
	});

	it("returns 404 for issue pretty-URL paths (ASSETS absent in test env)", async () => {
		const res = await SELF.fetch("http://localhost/projects/PROJ/issues/87/some-title");
		expect(res.status).toBe(404);
	});

	it("does not intercept /api/health — still returns 200", async () => {
		const res = await SELF.fetch("http://localhost/api/health");
		expect(res.status).toBe(200);
	});

	it("does not intercept /health — still returns 200", async () => {
		const res = await SELF.fetch("http://localhost/health");
		expect(res.status).toBe(200);
	});
});
