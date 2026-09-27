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

// ── Deprecated D1 fallback (no RATE_LIMITER binding; removed in PROJ-924) ──
function currentSlot(): number {
	return Math.floor(Date.now() / 1000 / WINDOW_SECS) * WINDOW_SECS;
}

async function seedD1Counter(key: string, count: number): Promise<void> {
	await env.DB.prepare(
		"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, ?, ?)"
	)
		.bind(key, count, currentSlot())
		.run();
}

// Run the worker without the Durable Object binding, as a deploy that hasn't added it yet.
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

describe("PROJ-361: opportunistic rate_limit row pruning (D1 fallback)", () => {
	const ENDPOINT = "http://localhost/api/workspaces";
	withoutLimiterBinding();

	it("prunes rows several windows stale while leaving the current window's row intact", async () => {
		const now = Math.floor(Date.now() / 1000);
		const staleWindowStart = now - WINDOW_SECS * 20; // well past the 10-window retention cutoff
		await seedD1Counter("ip:stale-client", 1);
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
		await seedD1Counter("ip:stale-client-2", 1);
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

// PROJ-432: the limiter runs on every request, and its upsert + read-back used to be two
// sequential awaits. They're one D1 batch now — same statements, same order, one round trip.
describe("PROJ-432: the D1 fallback counter costs one round trip", () => {
	const d1Only = (db: D1Database): Env => ({ ...env, DB: db, RATE_LIMITER: undefined });
	function countingDb(db: D1Database) {
		const counts = { prepare: 0, batch: 0 };
		const proxy = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === "prepare") counts.prepare++;
				if (prop === "batch") counts.batch++;
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { counts, proxy };
	}

	it("issues a single batch rather than sequential statements", async () => {
		const { counts, proxy } = countingDb(env.DB);
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // no prune
		try {
			await bumpRateCounter(
				d1Only(proxy),
				`ip:batch-${crypto.randomUUID().slice(0, 8)}`,
				WINDOW_SECS
			);
		} finally {
			randomSpy.mockRestore();
		}

		expect(counts.batch).toBe(1);
	});

	it("still counts correctly through the batch", async () => {
		const key = `ip:batch-count-${crypto.randomUUID().slice(0, 8)}`;
		expect(await bumpRateCounter(d1Only(env.DB), key, WINDOW_SECS)).toBe(1);
		expect(await bumpRateCounter(d1Only(env.DB), key, WINDOW_SECS)).toBe(2);
		expect(await bumpRateCounter(d1Only(env.DB), key, WINDOW_SECS)).toBe(3);
	});
});

describe("PROJ-867: counters live in the RateLimiter Durable Object, not D1", () => {
	const ENDPOINT = "http://localhost/api/workspaces";

	async function rateLimitRows(): Promise<number> {
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limit").first<{ n: number }>();
		return row?.n ?? 0;
	}

	it("GET requests write nothing to D1", async () => {
		const fixture = await seedFixture();
		for (let i = 0; i < 3; i++) {
			const res = await SELF.fetch(ENDPOINT, {
				headers: authHeaders(fixture.token, fixture.workspace.slug),
			});
			expect(res.status).toBe(200);
		}
		await SELF.fetch(ENDPOINT); // IP-keyed, unauthenticated
		expect(await rateLimitRows()).toBe(0);
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
		expect(await rateLimitRows()).toBe(0);
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

	describe("without the binding (deploys not yet updated)", () => {
		withoutLimiterBinding();

		it("falls back to the D1 counter and still enforces the limit", async () => {
			await seedD1Counter("ip:127.0.0.1", AUTH_LIMIT);
			const res = await SELF.fetch(ENDPOINT);
			expect(res.status).toBe(429);
		});
	});
});
