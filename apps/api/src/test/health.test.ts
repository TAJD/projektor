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

	it("returns 404 for /wiki/:slug pretty-URL paths (ASSETS absent in test env)", async () => {
		const res = await SELF.fetch("http://localhost/wiki/some-page");
		expect(res.status).toBe(404);
	});

	it("returns 404 for the legacy /wiki?slug= redirect route (ASSETS absent in test env)", async () => {
		const res = await SELF.fetch("http://localhost/wiki?slug=some-page");
		expect(res.status).toBe(404);
	});
});

// PROJ-517 finding 4: index.ts's SSR wikiSlugMatch regex must stay anchored the same
// way as apps/web/src/islands/WikiPage.tsx's slugFromPathname, or a request like
// /wiki/roadmap/anything would match server-side (injecting Roadmap's real SSR
// metadata) while the client renders empty — a server/client routing disagreement.
// The full route (index.ts's `app.get("*", ...)`) isn't reachable in this test env
// (ASSETS is absent, see the describe block above), so this asserts the regex itself
// directly — kept in sync with the literal in index.ts.
describe("SSR wiki-path regex (index.ts wikiSlugMatch, PROJ-517 finding 4)", () => {
	const wikiSlugMatch = /^\/wiki\/([^/]+)\/?$/;

	it("matches a bare single-segment slug", () => {
		expect(wikiSlugMatch.exec("/wiki/roadmap")?.[1]).toBe("roadmap");
	});

	it("matches a single-segment slug with a trailing slash", () => {
		expect(wikiSlugMatch.exec("/wiki/roadmap/")?.[1]).toBe("roadmap");
	});

	it("does not match extra path segments after the slug", () => {
		expect(wikiSlugMatch.exec("/wiki/roadmap/anything/at/all")).toBeNull();
	});
});
