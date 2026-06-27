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
