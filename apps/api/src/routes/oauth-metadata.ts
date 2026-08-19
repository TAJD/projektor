import type { HonoEnv } from "@projektor/types";
import { type Context, Hono } from "hono";
import { OAUTH_SCOPES_SUPPORTED } from "../auth/scopes";

// PROJ-655: the two public OAuth discovery documents, mounted under /.well-known.
//
// RFC 9728 protected resource metadata is the one hard MUST the MCP authorization
// spec places on a resource server — it is the entry point for the entire connector
// flow. RFC 8414 authorization server metadata is what the PRM points at.
//
// Both are unauthenticated by design and are mounted ahead of authMiddleware /
// workspaceMiddleware in index.ts. Deployment note: they only reach the Worker in a
// release deploy because `/.well-known/*` is in `run_worker_first` (PROJ-650) — the
// static-asset handler would otherwise answer with the SPA fallback.

const router = new Hono<HonoEnv>();

// Claude caches discovery documents globally by URL for roughly 5 minutes, so a
// short shared cache here costs nothing and absorbs the probe traffic. These
// documents are identical for every caller.
const CACHE_CONTROL = "public, max-age=3600";

// The global cors() in index.ts is an allowlist that denies by default, which is
// right for the credentialed API but wrong for these two documents: RFC 9728
// expects the metadata endpoint to be reachable from a browser, and a browser-based
// MCP client on any origin must be able to read them. They carry no credentials and
// no per-caller data, so a wildcard is safe here and only here.
const PUBLIC_HEADERS = {
	"Cache-Control": CACHE_CONTROL,
	"Access-Control-Allow-Origin": "*",
};

function originOf(c: { req: { url: string } }): string {
	return new URL(c.req.url).origin;
}

// RFC 9728 §3.1 path-suffixed variant: /.well-known/oauth-protected-resource/<path>.
//
// This MUST be per-workspace. Projektor's MCP resource is /mcp/<workspaceId>, and
// Claude requires the PRM `resource` field to match the URL the user typed into the
// connector dialog exactly, including the path component. A single origin-level
// document saying `resource: <origin>` fails that comparison and the connection dies
// with a discovery error — which is why the origin-level variant is deliberately NOT
// served (see the note at the bottom of this file).
//
// The workspace is not looked up. Returning 404 for an unknown id would turn this
// unauthenticated endpoint into an existence oracle for workspace ids, and the
// document contains nothing workspace-specific to protect — it is entirely derived
// from the request URL. An id that does not resolve fails later, at the MCP request
// itself, behind authentication where it belongs.
router.get("/oauth-protected-resource/mcp/:workspaceId", (c) => {
	const origin = originOf(c);
	// Re-encode rather than interpolating the raw segment: this value lands in a URL
	// that clients compare byte-for-byte against the one the user entered.
	const workspaceId = encodeURIComponent(c.req.param("workspaceId"));

	return c.json(
		{
			resource: `${origin}/mcp/${workspaceId}`,
			authorization_servers: [origin],
			bearer_methods_supported: ["header"],
			// No `offline_access`: the MCP spec says a protected resource SHOULD NOT
			// advertise it. Refresh-token support is advertised where it belongs, in
			// the authorization server's `grant_types_supported` below.
			scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
		},
		200,
		PUBLIC_HEADERS
	);
});

// RFC 8414 authorization server metadata. `issuer` is the bare origin, which is what
// makes this document's own location (/.well-known/oauth-authorization-server, no
// path suffix) the correct one per RFC 8414 §3.
router.get("/oauth-authorization-server", (c) => {
	const origin = originOf(c);

	return c.json(
		{
			issuer: origin,
			authorization_endpoint: `${origin}/oauth/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			revocation_endpoint: `${origin}/oauth/revoke`,
			response_types_supported: ["code"],
			response_modes_supported: ["query"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			// OAuth 2.1: PKCE is mandatory and `plain` is not offered.
			code_challenge_methods_supported: ["S256"],
			// The two CIMD gating flags. Claude selects Client ID Metadata Documents
			// only when `client_id_metadata_document_supported` is true AND "none"
			// appears in `token_endpoint_auth_methods_supported`. Missing either one
			// and it silently falls back to hunting for a `registration_endpoint`.
			token_endpoint_auth_methods_supported: ["none"],
			client_id_metadata_document_supported: true,
			revocation_endpoint_auth_methods_supported: ["none"],
			// RFC 9207. Advertised because PROJ-656 emits `iss` on authorization
			// responses; a client may reject an `iss` it was not told to expect.
			authorization_response_iss_parameter_supported: true,
			scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
			// Deliberately absent: `registration_endpoint`. RFC 7591 Dynamic Client
			// Registration is deprecated, and advertising it would make clients prefer
			// DCR over CIMD — the opposite of what the flags above are arranging.
		},
		200,
		PUBLIC_HEADERS
	);
});

// Deliberately not served: the origin-level `/.well-known/oauth-protected-resource`.
// Claude probes the path-suffixed URL above first and only falls back to the bare one.
// Answering the fallback could only claim `resource: <origin>`, which no user ever
// enters as an MCP URL (there is no MCP endpoint at the origin) and which would fail
// the exact-match check anyway. A 404 sends the client back to the correct document
// instead of handing it a wrong one.
//
// But "not served" has to be made explicit. PROJ-650 put `/.well-known/*` in
// `run_worker_first`, so in a real deploy every path under it now reaches the Worker,
// and an unmatched one falls through to the SPA catch-all at the bottom of index.ts —
// which answers `200 text/html` with the app shell. For a client expecting discovery
// JSON that is strictly worse than a clean 404: it is a success status carrying an
// HTML page. Scoped to the `oauth-*` namespace on purpose, so unrelated well-known
// paths a self-hoster may add (security.txt, ACME challenges) still fall through to
// the static-asset handler.
//
// Note this is invisible under `wrangler dev` and in the test suite, neither of which
// has an ASSETS binding — there, the catch-all already 404s. The regression test
// asserts the *content type* rather than the status for exactly that reason.
const discoveryNotFound = (c: Context<HonoEnv>) => c.json({ error: "Not Found" }, 404);

router.all("/oauth-protected-resource", discoveryNotFound);
router.all("/oauth-protected-resource/*", discoveryNotFound);
router.all("/oauth-authorization-server", discoveryNotFound);
router.all("/oauth-authorization-server/*", discoveryNotFound);

export { router as oauthMetadataRouter };
