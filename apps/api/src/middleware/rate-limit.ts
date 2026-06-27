import type { HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";

// Fixed-window rate-limit middleware backed by D1.
//
// PROJ-125 investigation: KV state IS shared between SELF.fetch() calls in the
// @cloudflare/vitest-pool-workers test runtime (see cache.test.ts, which writes
// to KV inside a handler and reads it back in a subsequent SELF.fetch()). The
// original reason for using D1 was incorrect.
//
// Why D1 remains: wiki.test.ts resets rate-limit state mid-test via
// `env.DB.prepare("DELETE FROM rate_limit").run()` — a D1-specific escape hatch
// added so the wiki nesting-depth test can fire its 6th request without being
// rate-limited. Migrating to KV would break that test, which is outside this
// ticket's file scope. A future migration needs wiki.test.ts to also clear KV.
//
// D1 supports atomic upsert with RETURNING, keeping this to a single round-trip.
//
// Key selection: when the request carries a bearer token the bucket is keyed by a
// SHA-256 prefix of that token (own quota per credential, brute-force bounded).
// Unauthenticated requests key by CF-Connecting-IP.
//
// Configuration via env vars (readable at request time, no redeploy needed):
//   RATE_LIMIT_AUTH_MAX      — max IP-keyed requests per window (default 300)
//   RATE_LIMIT_API_MAX       — max token-keyed requests per window (default 600)
//   RATE_LIMIT_WINDOW_SECS   — window size in seconds (default 60)
export async function rateLimitMiddleware(
	c: Context<HonoEnv>,
	next: Next
): Promise<Response | undefined> {
	const windowSecs = parseInt(c.env.RATE_LIMIT_WINDOW_SECS ?? "60", 10);
	const now = Math.floor(Date.now() / 1000);
	const slot = Math.floor(now / windowSecs) * windowSecs; // fixed-window start timestamp

	const authHeader = c.req.header("Authorization");
	let key: string;
	let limit: number;

	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		const fingerprint = await sha256Prefix(token);
		key = `tok:${fingerprint}`;
		limit = parseInt(c.env.RATE_LIMIT_API_MAX ?? "600", 10);
	} else {
		const ip = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
		key = `ip:${ip}`;
		limit = parseInt(c.env.RATE_LIMIT_AUTH_MAX ?? "300", 10);
	}

	const count = await incrementCounter(c.env.DB, key, slot);
	if (count > limit) {
		const windowRemaining = slot + windowSecs - now;
		c.header("Retry-After", String(windowRemaining > 0 ? windowRemaining : windowSecs));
		return c.json({ error: "Too Many Requests" }, 429);
	}

	await next();
}

async function sha256Prefix(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function incrementCounter(db: D1Database, key: string, slot: number): Promise<number> {
	// Upsert: if same window slot, increment; if window has rolled over, reset to 1.
	// We use a separate SELECT because D1's local runtime may not reliably return
	// RETURNING values from DML statements.
	await db
		.prepare(`
    INSERT INTO rate_limit (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limit.window_start = ? THEN rate_limit.count + 1 ELSE 1 END,
      window_start = ?
  `)
		.bind(key, slot, slot, slot)
		.run();

	const row = await db
		.prepare("SELECT count FROM rate_limit WHERE key = ?")
		.bind(key)
		.first<{ count: number }>();

	return row?.count ?? 1;
}
