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
// The upsert and its read-back are issued as one D1 batch, so this costs a single round
// trip (see incrementCounter — RETURNING would be tidier but isn't reliable locally).
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
	const testNow =
		c.env.ENVIRONMENT !== "production" && c.env.RATE_LIMIT_TEST_NOW_MS
			? Number(c.env.RATE_LIMIT_TEST_NOW_MS)
			: NaN;
	const nowMs = Number.isFinite(testNow) ? testNow : Date.now();
	const now = Math.floor(nowMs / 1000);
	const slot = Math.floor(now / windowSecs) * windowSecs; // fixed-window start timestamp

	const authHeader = c.req.header("Authorization");
	let key: string;
	let limit: number;

	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		key = `tok:${oauthGrantKey(token) ?? (await sha256Prefix(token))}`;
		limit = parseInt(c.env.RATE_LIMIT_API_MAX ?? "600", 10);
	} else {
		const ip = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
		key = `ip:${ip}`;
		limit = parseInt(c.env.RATE_LIMIT_AUTH_MAX ?? "300", 10);
	}

	// PROJ-430: every request writes then reads one hot row, so a burst from a
	// single key serialises on it. A D1 error here is a limiter outage, not a
	// client problem — fail open rather than turning it into a 500 for a request
	// that would otherwise have succeeded.
	let count: number;
	try {
		count = await incrementCounter(c.env.DB, key, slot, windowSecs);
	} catch (err) {
		console.error("rate-limit counter unavailable, failing open", { key, err: String(err) });
		await next();
		return;
	}

	if (count > limit) {
		const windowRemaining = slot + windowSecs - now;
		c.header("Retry-After", String(windowRemaining > 0 ? windowRemaining : windowSecs));
		return c.json({ error: "Too Many Requests" }, 429);
	}

	await next();
}

// PROJ-658: an OAuth access token is `<userId>:<grantId>:<secret>` and rotates roughly
// hourly. Fingerprinting the whole token would hand every connector a fresh budget on
// each rotation, which is most of the way to no limit at all. The user and grant halves
// are stable for the life of the grant, so they are what the bucket is keyed on.
//
// Deliberately not keyed on the user alone. The limiter runs before authentication, so
// the key comes from an unverified string — and a bucket a stranger can name is a bucket
// a stranger can exhaust. The grant id is 16 random characters and appears nowhere but
// inside the token, so it cannot be guessed the way a user id could be.
function oauthGrantKey(token: string): string | null {
	const parts = token.split(":");
	if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
	return `grant:${parts[0]}:${parts[1]}`;
}

/**
 * Bump a fixed-window counter and return the new count. Shared so the auth-failure
 * throttle (middleware/auth.ts, PROJ-198) reuses the same backing table and window math
 * as the request limiter above.
 */
export async function bumpRateCounter(
	db: D1Database,
	key: string,
	windowSecs: number
): Promise<number> {
	const slot = Math.floor(Math.floor(Date.now() / 1000) / windowSecs) * windowSecs;
	return incrementCounter(db, key, slot, windowSecs);
}

async function sha256Prefix(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// PROJ-361: rate_limit gets one permanent row per distinct IP/token (scanners,
// crawlers, one-off visitors never come back to roll their window over) with no
// cleanup path. Rather than a scheduled job for what's small, low-priority
// housekeeping, prune opportunistically from inside the hot path — rows several
// windows old are never read again by the fixed-window logic above.
const PRUNE_PROBABILITY = 0.01;
const PRUNE_RETENTION_WINDOWS = 10;

function pruneStaleRateLimitRows(db: D1Database, windowSecs: number): D1PreparedStatement {
	const cutoff = Math.floor(Date.now() / 1000) - windowSecs * PRUNE_RETENTION_WINDOWS;
	return db.prepare("DELETE FROM rate_limit WHERE window_start < ?").bind(cutoff);
}

async function incrementCounter(
	db: D1Database,
	key: string,
	slot: number,
	windowSecs: number
): Promise<number> {
	// Upsert: if same window slot, increment; if window has rolled over, reset to 1.
	// We use a separate SELECT because D1's local runtime may not reliably return
	// RETURNING values from DML statements.
	//
	// PROJ-432: sent as one batch rather than sequential awaits. D1 runs a batch in order
	// inside an implicit transaction, so the SELECT still observes the upsert above it —
	// but the whole thing costs one round trip instead of two (three when pruning).
	const statements = [
		db
			.prepare(`
    INSERT INTO rate_limit (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limit.window_start = ? THEN rate_limit.count + 1 ELSE 1 END,
      window_start = ?
  `)
			.bind(key, slot, slot, slot),
		db.prepare("SELECT count FROM rate_limit WHERE key = ?").bind(key),
	];

	// Last in the batch: it only ever deletes rows many windows older than the one just
	// written, so it cannot race the count above.
	if (Math.random() < PRUNE_PROBABILITY) {
		statements.push(pruneStaleRateLimitRows(db, windowSecs));
	}

	const [, selected] = await db.batch<{ count: number }>(statements);

	return selected.results[0]?.count ?? 1;
}
