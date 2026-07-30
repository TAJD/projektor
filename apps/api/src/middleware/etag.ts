import type { HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";

// PROJ-439: conditional GETs on the read-heavy JSON routes.
//
// The tag is a hash of the response body, computed after the handler has run. That
// costs the D1/KV read either way — it saves the payload, the client's JSON.parse and
// the island re-render, not server time. The alternative (deriving from updated_at or a
// version counter, so the query could be skipped) was measured against the tree and
// rejected on the ticket: getIssue/listProjects/listTaskStatuses already read through a
// KV cache, so a version probe trades one read for another, and a `no-cache` ETag has no
// TTL to bound a missed invalidation the way that cache's 60-300s does.
//
// Deliberately not `hono/etag`: it guards on neither method nor status, so a repeat
// request carrying a matching If-None-Match gets a 304 in place of its 403.

// `private` — these are per-user authorised responses behind Cloudflare Access, so no
// shared cache may hold them. `no-cache` means "store, but revalidate every time",
// which is the point; a max-age would risk showing one user a stale or foreign view.
const CACHE_CONTROL = "private, no-cache";

export async function etagMiddleware(c: Context<HonoEnv>, next: Next): Promise<void> {
	await next();

	// Registered after authMiddleware/workspaceMiddleware on the same prefixes, so an
	// unauthorised request never reaches here. This guard is the second lock: a 304 must
	// never stand in for a 401/403/404.
	if (c.req.method !== "GET" || c.res.status !== 200) return;

	const body = await c.res.clone().arrayBuffer();
	const etag = `"${await sha256Prefix(body)}"`;

	if (ifNoneMatchMatches(c.req.header("If-None-Match"), etag)) {
		// cofferdam-ignore: Refactor.MutatedParameter: setting c.res is the standard Hono middleware contract, not an accidental mutation
		c.res = new Response(null, {
			status: 304,
			headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
		});
		return;
	}

	c.res.headers.set("ETag", etag);
	c.res.headers.set("Cache-Control", CACHE_CONTROL);
}

function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
	if (!header) return false;
	if (header.trim() === "*") return true;
	const stripWeak = (t: string) => t.trim().replace(/^W\//, "");
	return header.split(",").some((t) => stripWeak(t) === stripWeak(etag));
}

async function sha256Prefix(input: ArrayBuffer): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", input);
	return Array.from(new Uint8Array(buf).slice(0, 16))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
