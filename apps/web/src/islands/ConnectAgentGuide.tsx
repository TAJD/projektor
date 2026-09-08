import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { resolveWorkspaceSlug } from "../utils/workspace";
import { Button } from "./ui/Button";

interface Props {
	workspaceSlug?: string;
}

interface McpInfo {
	mcpUrl: string;
}

const URL_CODE_CLASS =
	"flex-1 font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded text-text-base break-all";

async function copyToClipboard(text: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {}
}

export default function ConnectAgentGuide({ workspaceSlug: propWorkspaceSlug }: Props) {
	const workspaceSlug = resolveWorkspaceSlug(propWorkspaceSlug);
	const [mcpUrl, setMcpUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!workspaceSlug) return;
		apiFetch<McpInfo>(`/api/workspaces/${workspaceSlug}/mcp-info`, { workspaceSlug })
			.then((data) => setMcpUrl(data.mcpUrl))
			.catch(() => {});
	}, [workspaceSlug]);

	if (!workspaceSlug) return null;

	return (
		<div class="mb-6 px-5 py-4 bg-surface border border-border rounded-lg">
			<h3 class="m-0 mb-3 text-base font-semibold text-text-base">Connect Claude Code</h3>
			<ol class="m-0 mb-3 pl-5 text-sm text-text-base [&>li]:mb-1.5">
				<li>In Claude, go to Settings → Connectors and click "Add custom connector."</li>
				<li>
					Paste this server URL{mcpUrl ? "" : " (loading…)"}, leave request headers empty, and click
					Add.
				</li>
				<li>Sign in when prompted, then approve the consent screen.</li>
			</ol>
			{mcpUrl && (
				<div class="flex items-center gap-2">
					<code class={URL_CODE_CLASS}>{mcpUrl}</code>
					<Button variant="outline" size="sm" onClick={() => copyToClipboard(mcpUrl)}>
						Copy
					</Button>
				</div>
			)}
			<p class="m-0 mt-3 text-xs text-text-muted">
				What you can see and do is automatically scoped to your workspace role and group access — no
				token or admin step needed.
			</p>
		</div>
	);
}
