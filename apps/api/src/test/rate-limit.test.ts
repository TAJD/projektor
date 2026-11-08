import { env, SELF } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpRateCounter, LIMITER_TIMEOUT_MS } from "../middleware/rate-limit";
import { authHeaders, seedFixture } from "./helpers";
import { seedRateLimitCounter } from "./rate-limit-reset";

// Must match wrangler.test.toml values.
const AUTH_LIMIT = 3;
const API_LIMIT = 5;
const WINDOW_SECS = 60; // RATE_LIMIT_WINDOW_SECS in wrangler.test.toml

// SHA-256 prefix — mirrors the middleware so we can pre-seed the correct key.
async function sha256Prefix(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Put a key at `count` hits in the current window (RateLimiter Durable Object).
async function seedCounter(key: string, count: number): Promise<void> {
	await seedRateLimitCounter(key, count, WINDOW_SECS);
}

function currentSlot(): number {
	return Math.floor(Date.now() / 1000 / WINDOW_SECS) * WINDOW_SECS;
}

function withoutLimiterBinding() {
	let saved: Env["RATE_LIMITER"];
	beforeEach(() => {
		saved = env.RATE_LIMITER;
		env.RATE_LIMITER = undefined;
	});
	afterEach(() => {
		env.RATE_LIMITER = saved;
	});
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

describe("PROJ-867: counters live in the RateLimiter Durable Object, not D1", () => {
	const ENDPOINT = "http://localhost/api/workspaces";

	it("the rate_limit table is gone (PROJ-924)", async () => {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit'"
		).first();
		expect(row).toBeNull();
	});

	it("still enforces the token limit (API max 5) from the Durable Object counter", async () => {
		const fixture = await seedFixture();
		const statuses: number[] = [];
		for (let i = 0; i < API_LIMIT + 1; i++) {
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			statuses.push(res.status);
		}
		expect(statuses.slice(0, API_LIMIT).every((s) => s === 200)).toBe(true);
		expect(statuses[API_LIMIT]).toBe(429);
	});

	it("Retry-After is the seconds left in the fixed window, as before", async () => {
		const slotStartMs = currentSlot() * 1000;
		env.RATE_LIMIT_TEST_NOW_MS = String(slotStartMs + 20_000); // 20s into the window
		try {
			const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
			let res: Response | undefined;
			for (let i = 0; i < AUTH_LIMIT + 1; i++) {
				res = await SELF.fetch(ENDPOINT, { headers: { "CF-Connecting-IP": ip } });
			}
			expect(res?.status).toBe(429);
			expect(res?.headers.get("Retry-After")).toBe(String(WINDOW_SECS - 20));
			expect(await res?.json()).toEqual({ error: "Too Many Requests" });
		} finally {
			env.RATE_LIMIT_TEST_NOW_MS = undefined;
		}
	});

	describe("fails open when the limiter is unavailable", () => {
		let saved: Env["RATE_LIMITER"];
		beforeEach(() => {
			saved = env.RATE_LIMITER;
		});
		afterEach(() => {
			env.RATE_LIMITER = saved;
		});

		function fakeNamespace(increment: () => Promise<unknown>) {
			const calls = { n: 0 };
			const ns = {
				idFromName: (name: string) => name,
				get: () => ({
					increment: () => {
						calls.n++;
						return increment();
					},
				}),
			};
			return { calls, ns: ns as unknown as NonNullable<Env["RATE_LIMITER"]> };
		}

		it("allows the request when the Durable Object call throws", async () => {
			const fake = fakeNamespace(() => Promise.reject(new Error("DO down")));
			env.RATE_LIMITER = fake.ns;
			const fixture = await seedFixture();
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			expect(fake.calls.n).toBeGreaterThan(0);
			expect(res.status).toBe(200);
		});

		it("an invalid token still gets 401, not 500, from the auth-failure throttle", async () => {
			const fake = fakeNamespace(() => Promise.reject(new Error("DO down")));
			env.RATE_LIMITER = fake.ns;
			const res = await SELF.fetch(ENDPOINT, {
				headers: { Authorization: "Bearer pk_not_a_real_token" },
			});
			expect(fake.calls.n).toBeGreaterThanOrEqual(2); // request limiter + auth-failure throttle
			expect(res.status).toBe(401);
		});

		it("allows the request when the Durable Object doesn't answer in time", async () => {
			const fake = fakeNamespace(() => new Promise(() => {}));
			env.RATE_LIMITER = fake.ns;
			const fixture = await seedFixture();
			const started = Date.now();
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			expect(fake.calls.n).toBeGreaterThan(0);
			expect(res.status).toBe(200);
			expect(Date.now() - started).toBeLessThan(LIMITER_TIMEOUT_MS + 5_000);
		});
	});

	describe("without the binding (PROJ-924)", () => {
		withoutLimiterBinding();

		it("fails open, logs once and reports health as degraded", async () => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const statuses: number[] = [];
				for (let i = 0; i < AUTH_LIMIT + 2; i++) statuses.push((await SELF.fetch(ENDPOINT)).status);
				expect(statuses).not.toContain(429);
				expect(await bumpRateCounter(env, "authfail:203.0.113.9", WINDOW_SECS)).toBe(0);
				expect(await bumpRateCounter(env, "authfail:203.0.113.9", WINDOW_SECS)).toBe(0);
				expect(
					errors.mock.calls.filter((args) => String(args[0]).includes("RATE_LIMITER")).length
				).toBe(1);
			} finally {
				errors.mockRestore();
			}
			for (const path of ["/health", "/api/health"]) {
				const res = await SELF.fetch(`http://localhost${path}`);
				expect(res.status).toBe(503);
				expect(await res.json()).toMatchObject({ ok: false, degraded: [expect.any(String)] });
			}
		});
	});
});
