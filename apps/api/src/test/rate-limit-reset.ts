import { env } from "cloudflare:test";
import { rateLimiterObjectName } from "../middleware/rate-limit";

/**
 * Start every rate-limit counter afresh (PROJ-867).
 *
 * Counters live in RateLimiter Durable Objects, one per key, held in memory, so there is
 * no table to wipe. Instead this moves the test env to a new RATE_LIMIT_TEST_EPOCH, which
 * the limiter folds into every object name outside production — the next request lands
 * in a brand-new object with a zero count. The D1 table is still cleared for the
 * deprecated no-binding fallback path (PROJ-924).
 */
export async function resetRateLimits(): Promise<void> {
	env.RATE_LIMIT_TEST_EPOCH = crypto.randomUUID();
	await env.DB.prepare("DELETE FROM rate_limit").run();
}

/**
 * Put a limiter key at `count` hits in the current fixed window, as if `count` requests had
 * already been made. Goes straight to the key's RateLimiter object, so it exercises the
 * same counter the middleware uses.
 *
 * PROJ-637: the window is fixed, so seeding in the last moments of one window and sending
 * the request in the next silently clears the cap. Wait out the tail of the window first.
 */
export async function seedRateLimitCounter(
	key: string,
	count: number,
	windowSecs = 60
): Promise<void> {
	const windowMs = windowSecs * 1000;
	const intoWindow = Date.now() % windowMs;
	const HEADROOM_MS = 5_000;
	if (intoWindow > windowMs - HEADROOM_MS) {
		await new Promise((resolve) => setTimeout(resolve, windowMs - intoWindow + 50));
	}
	const ns = env.RATE_LIMITER;
	if (!ns) throw new Error("RATE_LIMITER binding missing from wrangler.test.toml");
	const stub = ns.get(ns.idFromName(rateLimiterObjectName(env, key)));
	const nowSecs = Math.floor(Date.now() / 1000);
	for (let i = 0; i < count; i++) await stub.increment(windowSecs, nowSecs);
}
