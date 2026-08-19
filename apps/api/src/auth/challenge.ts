import { OAUTH_SCOPES_SUPPORTED } from "./scopes";

// PROJ-651: RFC 9728 `WWW-Authenticate` challenges for the MCP endpoint.
//
// This header is the only discovery entry point an MCP client has. Anthropic is
// explicit that Claude does not honour a `WWW-Authenticate` header on any non-401
// response, so the challenge has to ride on a real transport-level 401/403 — a 200
// carrying a JSON-RPC error is invisible to the step-up flow, and the user ends up
// reading "please sign in" prose in the chat instead of being offered a Connect
// button.
//
// Scoped to /mcp/* on purpose. /api/* 401s keep their bare shape: the frontend
// reloads the page to re-authenticate on a 401 and that behaviour is load-bearing
// (PROJ-430).

// RFC 9110 quoted-string. The values used here (a URL built from the request, and
// scope names from a fixed list) contain neither quotes nor backslashes today, but a
// challenge header that can be broken by its own payload is not worth the gamble.
function quote(value: string): string {
	return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

function bearerChallenge(params: Readonly<Record<string, string>>): string {
	const rendered = Object.entries(params)
		.map(([key, value]) => `${key}=${quote(value)}`)
		.join(", ");
	return `Bearer ${rendered}`;
}

/**
 * The per-workspace protected resource metadata URL for an MCP request.
 *
 * Per-workspace, not origin-level: Claude compares the PRM document's `resource`
 * field against the URL the user typed into the connector dialog, path component
 * included, so pointing at an origin-level document fails the match (PROJ-655).
 * Derived from the request rather than a configured origin so it stays correct on
 * every hostname an instance is reachable at.
 */
export function protectedResourceMetadataUrl(requestUrl: string, workspaceId: string): string {
	const { origin } = new URL(requestUrl);
	return `${origin}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(workspaceId)}`;
}

/** `WWW-Authenticate` for an unauthenticated MCP request (401). */
export function unauthorizedChallenge(requestUrl: string, workspaceId: string): string {
	return bearerChallenge({
		resource_metadata: protectedResourceMetadataUrl(requestUrl, workspaceId),
		scope: OAUTH_SCOPES_SUPPORTED.join(" "),
	});
}

/**
 * `WWW-Authenticate` for an authenticated MCP request whose token lacks the scope
 * for the operation (403).
 *
 * Names the complete scope set rather than only the missing one. Challenging
 * incrementally would force the user through a second consent round-trip the moment
 * the client touched a different operation, and with exactly two scopes there is no
 * meaningful over-ask: `projektor:write` already implies read internally, so the
 * complete set is what any grant that can satisfy this request looks like anyway.
 */
export function insufficientScopeChallenge(requestUrl: string, workspaceId: string): string {
	return bearerChallenge({
		error: "insufficient_scope",
		resource_metadata: protectedResourceMetadataUrl(requestUrl, workspaceId),
		scope: OAUTH_SCOPES_SUPPORTED.join(" "),
	});
}
