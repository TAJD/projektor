import { DurableObject } from "cloudflare:workers";

// PROJ-867: fixed-window rate-limit counter, one Durable Object per (class, subject) key
// (see middleware/rate-limit.ts for how keys are named).
//
// Why a Durable Object and not the Workers Rate Limiting binding: the binding only answers
// allow/deny, fixes its limit and period (10s or 60s) in wrangler config, and is
// approximate per colo. That would change the 429 contract (Retry-After = seconds left in
// the window), stop the RATE_LIMIT_* env vars from working, and couldn't express the
// hourly tiers PROJ-899 needs. One DO per key gives exact counts, any window, and
// request-time limits, for one small RPC instead of a D1 write transaction.
//
// State is deliberately in memory only — no ctx.storage writes — so a request costs no
// durable write at all. If the object is evicted (idle for a while), its window restarts
// from zero: a lost count only ever lets traffic through, the same failure direction as
// the limiter's fail-open, and a key that is actually hammering the limiter stays hot.
export class RateLimiter extends DurableObject {
	private windowStart = -1;
	private count = 0;

	/**
	 * Count one hit in the fixed window containing `nowSecs` and return the new count and
	 * the window's start. The caller passes its own clock (and window size) so the math is
	 * identical to the previous D1 limiter and the test clock override keeps working.
	 */
	increment(windowSecs: number, nowSecs: number): { count: number; slot: number } {
		const slot = Math.floor(nowSecs / windowSecs) * windowSecs;
		if (slot !== this.windowStart) {
			this.windowStart = slot;
			this.count = 0;
		}
		this.count += 1;
		return { count: this.count, slot };
	}
}
