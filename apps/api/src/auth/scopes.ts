import { z } from "zod";

/**
 * Capabilities an API token can be granted (PROJ-17).
 * - "read"  — read-only access.
 * - "write" — mutating access (implies "read").
 * - "*"     — full access (read + write); convenient default.
 */
export const ScopeSchema = z.enum(["read", "write", "*"]);
export type Scope = z.infer<typeof ScopeSchema>;

/** The capability a given request requires. */
export type Capability = "read" | "write";

/**
 * Does a token's scope set permit the required capability?
 * - "*" grants everything.
 * - "write" implies "read" (you can read what you can write).
 * - Unknown/legacy scope strings grant nothing (fail-closed).
 */
export function tokenAllows(scopes: readonly string[], required: Capability): boolean {
	if (scopes.includes("*")) return true;
	if (required === "write") return scopes.includes("write");
	return scopes.includes("read") || scopes.includes("write");
}

/**
 * REST capability implied by an HTTP method: safe methods read, everything
 * else writes. (Searches are GET, so they classify as reads.)
 */
export function capabilityForMethod(method: string): Capability {
	const m = method.toUpperCase();
	return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/**
 * Capability an MCP tool requires, by name convention. The read tools are the
 * list_/get_/search_ family (plus wiki_tree); everything else is treated as a
 * write. Fail-closed: a new tool without a read prefix needs the write scope.
 */
export function capabilityForMcpTool(name: string): Capability {
	if (
		name.startsWith("list_") ||
		name.startsWith("get_") ||
		name.startsWith("search_") ||
		name === "wiki_tree"
	) {
		return "read";
	}
	return "write";
}

/**
 * Parse the `scopes` column into a string[]. Current code stores it as a JSON
 * array; some early rows stored an unquoted bracketed list (e.g. "[read,write]",
 * not valid JSON). Both are accepted so legacy tokens keep working. Anything
 * else fails closed to [] (which tokenAllows() then treats as "grants nothing").
 */
export function parseScopes(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		// Legacy fallback: only an unquoted bracketed list like "[read,write]".
		const m = raw.match(/^\s*\[(.*)\]\s*$/);
		if (!m) return [];
		return m[1]
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
}

/**
 * OAuth wire scope names (PROJ-655).
 *
 * These are a PUBLIC CONTRACT, not an internal detail: they appear in
 * `scopes_supported` on the discovery documents and in the `scope` value of the
 * `WWW-Authenticate` challenge, and Claude caches discovery documents globally
 * by URL (~5 minutes) across every user of an instance. Renaming one later
 * propagates lazily and inconsistently, so they are chosen once and pinned here.
 *
 * Deliberately namespaced rather than reusing the bare "read"/"write" strings
 * above. Two reasons: OAuth scope names are shown to the human on the consent
 * screen and in Claude's connector UI, where an unqualified "write" says nothing
 * about what it writes; and keeping the wire names distinct from the values
 * stored in `api_tokens.scopes` leaves the internal representation free to
 * change without breaking a contract we cannot recall.
 *
 * Exactly two, mirroring `Capability`. No per-tool or per-project granularity:
 * the live `workspace_members` role and group-grant check remains the real
 * authority on every request, and a token can never exceed it, so finer scopes
 * would imply a precision the authorization model does not actually have.
 */
export const OAUTH_SCOPE_READ = "projektor:read";
export const OAUTH_SCOPE_WRITE = "projektor:write";
export const OAUTH_SCOPES_SUPPORTED = [OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE] as const;

/**
 * Map an OAuth wire scope to the capability it grants, or null if it is not one
 * we issue. Fail-closed, same as tokenAllows(): an unrecognized scope grants
 * nothing rather than being silently treated as read.
 */
export function capabilityForOAuthScope(scope: string): Capability | null {
	if (scope === OAUTH_SCOPE_READ) return "read";
	if (scope === OAUTH_SCOPE_WRITE) return "write";
	return null;
}
