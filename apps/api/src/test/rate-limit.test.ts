import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedFixture } from "./helpers";

// Must match wrangler.test.toml values.
const AUTH_LIMIT = 3;
const API_LIMIT = 5;
const WINDOW_SECS = 60; // RATE_LIMIT_WINDOW_SECS in wrangler.test.toml

// Current fixed-window slot — the middleware uses the same formula.
function currentSlot(): number {
	return Math.floor(Date.now() / 1000 / WINDOW_SECS) * WINDOW_SECS;
}

// SHA-256 prefix — mirrors the middleware so we can pre-seed the correct key.
async function sha256Prefix(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Seed the rate_limit table at the limit value from TEST code.
async function seedCounter(key: string, count: number): Promise<void> {
	const slot = currentSlot();
	await env.DB.prepare(
		"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, ?, ?)"
	)
		.bind(key, count, slot)
		.run();
}

describe("PROJ-19: rate limiting", () => {
	const ENDPOINT = "http://localhost/api/workspaces";

	describe("IP-keyed (no bearer token)", () => {
		it("allows a request within the limit", async () => {
			// No CF-Connecting-IP → middleware falls back to '127.0.0.1'
			const res = await SELF.fetch(ENDPOINT);
			// 401 from auth is the expected non-rate-limited response
			expect(res.status).not.toBe(429);
		});

		it("returns 429 with Retry-After when the IP limit is exceeded", async () => {
			// Seed against the fallback IP used when CF-Connecting-IP is absent in tests
			await seedCounter("ip:127.0.0.1", AUTH_LIMIT);

			const res = await SELF.fetch(ENDPOINT); // no CF-Connecting-IP → key = ip:127.0.0.1
			expect(res.status).toBe(429);
			const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECS);
		});

		it("IP-keyed and token-keyed buckets are independent", async () => {
			// Exhaust the IP bucket; authenticated requests must not be affected
			await seedCounter("ip:127.0.0.1", AUTH_LIMIT);

			const fixture = await seedFixture();
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			// Token-keyed bucket is separate → should not be 429
			expect(res.status).not.toBe(429);
		});
	});

	describe("token-keyed (bearer token present)", () => {
		it("allows a request within the limit", async () => {
			const fixture = await seedFixture();
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			expect(res.status).not.toBe(429);
		});

		it("returns 429 with Retry-After when the token limit is exceeded", async () => {
			const fixture = await seedFixture();
			const fingerprint = await sha256Prefix(fixture.token);
			await seedCounter(`tok:${fingerprint}`, API_LIMIT);

			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			expect(res.status).toBe(429);
			const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECS);
		});

		it("does not share buckets between different tokens", async () => {
			const fixtureA = await seedFixture();
			const fixtureB = await seedFixture();

			// Exhaust fixtureA's token bucket; fixtureB's should be unaffected
			const fingerprintA = await sha256Prefix(fixtureA.token);
			await seedCounter(`tok:${fingerprintA}`, API_LIMIT);

			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixtureB.token, fixtureB.workspace.slug),
			});
			expect(res.status).not.toBe(429);
		});
	});
});
