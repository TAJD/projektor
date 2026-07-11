import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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

describe("PROJ-198: failed bearer-auth throttle (IP-keyed)", () => {
	const ENDPOINT = "http://localhost/api/workspaces";
	const AUTH_FAIL_LIMIT = 3; // RATE_LIMIT_AUTH_FAIL_MAX in wrangler.test.toml

	it("returns 401 for an invalid bearer token while under the failure limit", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			headers: { Authorization: "Bearer pk_not_a_real_token" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 429 once invalid bearer auths from one IP exceed the limit", async () => {
		// Pre-seed the IP's failure counter at the limit; the next invalid-token attempt trips it.
		// Without CF-Connecting-IP the middleware keys by the 127.0.0.1 fallback.
		await seedCounter("authfail:127.0.0.1", AUTH_FAIL_LIMIT);

		const res = await SELF.fetch(ENDPOINT, {
			headers: { Authorization: "Bearer pk_still_not_a_real_token" },
		});
		expect(res.status).toBe(429);
	});

	it("does not throttle a valid token even when the IP's failure counter is high", async () => {
		// A successful auth never touches the authfail counter, so legit clients sharing an IP
		// with an attacker are unaffected.
		await seedCounter("authfail:127.0.0.1", AUTH_FAIL_LIMIT + 5);
		const fixture = await seedFixture();

		const res = await SELF.fetch(ENDPOINT, {
			headers: authHeaders(fixture.token, fixture.workspace.slug),
		});
		expect(res.status).not.toBe(429);
		expect(res.status).not.toBe(401);
	});
});

describe("PROJ-361: opportunistic rate_limit row pruning", () => {
	const ENDPOINT = "http://localhost/api/workspaces";

	it("prunes rows several windows stale while leaving the current window's row intact", async () => {
		const now = Math.floor(Date.now() / 1000);
		const staleWindowStart = now - WINDOW_SECS * 20; // well past the 10-window retention cutoff
		await seedCounter("ip:stale-client", 1);
		await env.DB.prepare("UPDATE rate_limit SET window_start = ? WHERE key = ?")
			.bind(staleWindowStart, "ip:stale-client")
			.run();

		// PRUNE_PROBABILITY is 1% — force the opportunistic prune to run this request.
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			const res = await SELF.fetch(ENDPOINT);
			expect(res.status).not.toBe(429);
		} finally {
			randomSpy.mockRestore();
		}

		const staleRow = await env.DB.prepare("SELECT key FROM rate_limit WHERE key = ?")
			.bind("ip:stale-client")
			.first();
		expect(staleRow).toBeNull();

		// The request above increments the current-window row for its own key (127.0.0.1) —
		// pruning must not have deleted it too.
		const currentRow = await env.DB.prepare("SELECT key FROM rate_limit WHERE key = ?")
			.bind("ip:127.0.0.1")
			.first();
		expect(currentRow).not.toBeNull();
	});

	it("does not prune when the probability roll misses", async () => {
		const now = Math.floor(Date.now() / 1000);
		const staleWindowStart = now - WINDOW_SECS * 20;
		await seedCounter("ip:stale-client-2", 1);
		await env.DB.prepare("UPDATE rate_limit SET window_start = ? WHERE key = ?")
			.bind(staleWindowStart, "ip:stale-client-2")
			.run();

		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // above PRUNE_PROBABILITY
		try {
			await SELF.fetch(ENDPOINT);
		} finally {
			randomSpy.mockRestore();
		}

		const staleRow = await env.DB.prepare("SELECT key FROM rate_limit WHERE key = ?")
			.bind("ip:stale-client-2")
			.first();
		expect(staleRow).not.toBeNull();
	});
});
