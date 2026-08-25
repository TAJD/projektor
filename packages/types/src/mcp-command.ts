export interface McpAddCommandParts {
	workspaceSlug: string;
	mcpUrl: string;
	token: string;
}

export function buildMcpAddCommand({ workspaceSlug, mcpUrl, token }: McpAddCommandParts): string {
	return (
		`claude mcp add --transport http ` +
		`--header "Authorization: Bearer ${token}" ` +
		`--header "X-Workspace-Slug: ${workspaceSlug}" ` +
		`projektor "${mcpUrl}"`
	);
}

export function buildMcpAddCommandMultiline({
	workspaceSlug,
	mcpUrl,
	token,
}: McpAddCommandParts): string {
	return [
		`claude mcp add --transport http \\`,
		`  --header "Authorization: Bearer ${token}" \\`,
		`  --header "X-Workspace-Slug: ${workspaceSlug}" \\`,
		`  projektor "${mcpUrl}"`,
	].join("\n");
}
