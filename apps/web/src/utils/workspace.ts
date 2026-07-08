// Resolve the active workspace slug on the client.
//
// Prefer the build-time PUBLIC_WORKSPACE_SLUG (set for local dev / single-tenant
// custom-domain builds). The generic release artifact never bakes it and instead
// relies on WORKSPACE_SUBDOMAIN_ROUTING, so fall back to the hostname's first label
// — the same rule the Worker uses to resolve the tenant from the Host header.
//
// Slug-less endpoints (/api/projects, /api/issues) resolve the workspace server-side
// and don't need this; endpoints that embed the slug in their path (groups, tokens)
// do. Returns "" during SSR (no `location`) and for host shapes with no tenant
// subdomain (localhost, bare IPs, single-label hosts).
export function resolveWorkspaceSlug(propSlug?: string): string {
	if (propSlug) return propSlug;
	if (typeof location === "undefined") return "";
	const host = location.hostname;
	if (host === "localhost" || /^[\d.]+$/.test(host) || host.split(".").length < 2) return "";
	return host.split(".")[0];
}
