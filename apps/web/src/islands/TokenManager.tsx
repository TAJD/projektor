import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface ApiToken {
	id: string;
	name: string;
	scopes: string; // raw JSON string e.g. '["read","write"]'
	lastUsedAt: number | null;
	expiresAt: number | null;
	createdAt: number;
}

interface NewTokenResult {
	id: string;
	token: string;
	name: string;
	scopes: string[];
	expiresAt: number | null;
}

interface Props {
	workspaceSlug?: string;
}

const SCOPE_READ = ["read"];
const SCOPE_READWRITE = ["read", "write"];

function parseScopes(raw: string): string[] {
	try {
		return JSON.parse(raw) as string[];
	} catch {
		return [];
	}
}

function formatDate(ts: number | null): string {
	if (ts === null) return "Never";
	return new Date(ts * 1000).toLocaleDateString();
}

function formatScopes(raw: string): string {
	const scopes = parseScopes(raw);
	if (scopes.includes("*")) return "Full access (*)";
	if (scopes.includes("write")) return "Read + Write";
	if (scopes.includes("read")) return "Read-only";
	return scopes.join(", ") || "—";
}

export default function TokenManager({ workspaceSlug }: Props) {
	const [tokens, setTokens] = useState<ApiToken[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);

	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [mcpCommandTemplate, setMcpCommandTemplate] = useState<string | null>(null);

	// Create form
	const [showCreate, setShowCreate] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createScope, setCreateScope] = useState<"read" | "readwrite">("readwrite");
	const [createExpiry, setCreateExpiry] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [newToken, setNewToken] = useState<NewTokenResult | null>(null);

	// Revoke confirm
	const [revokeId, setRevokeId] = useState<string | null>(null);
	const [revoking, setRevoking] = useState(false);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	const nameInputRef = useRef<HTMLInputElement>(null);

	const fetchTokens = useCallback(async () => {
		if (!workspaceSlug) return;
		setLoading(true);
		setError(null);
		setForbidden(false);
		try {
			const data = await apiFetch<ApiToken[]>(`/api/workspaces/${workspaceSlug}/tokens`, {
				workspaceSlug,
			});
			setTokens(Array.isArray(data) ? data : []);
		} catch (e) {
			if (String(e).includes(": 403")) {
				setForbidden(true);
			} else {
				setError(String(e));
			}
		} finally {
			setLoading(false);
		}
	}, [workspaceSlug]);

	useEffect(() => {
		(async () => {
			if (!workspaceSlug) return;
			try {
				const data = await apiFetch<{ id: string }>(`/api/workspaces/${workspaceSlug}`, {
					workspaceSlug,
				});
				setWorkspaceId(data.id);
			} catch {
				// non-fatal
			}
			try {
				const data = await apiFetch<{ mcpAddCommandTemplate: string }>(
					`/api/workspaces/${workspaceSlug}/mcp-info`,
					{ workspaceSlug }
				);
				setMcpCommandTemplate(data.mcpAddCommandTemplate);
			} catch {
				// non-fatal
			}
		})();
		fetchTokens();
	}, [workspaceSlug, fetchTokens]);

	function openCreate() {
		setShowCreate(true);
		setCreateName("");
		setCreateScope("readwrite");
		setCreateExpiry("");
		setCreateError(null);
		setNewToken(null);
		setTimeout(() => nameInputRef.current?.focus(), 0);
	}

	function closeCreate() {
		setShowCreate(false);
		setNewToken(null);
		setCreateError(null);
	}

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!workspaceSlug || !createName.trim()) return;
		setCreating(true);
		setCreateError(null);
		try {
			const scopes = createScope === "read" ? SCOPE_READ : SCOPE_READWRITE;
			const body: Record<string, unknown> = { name: createName.trim(), scopes };
			const days = parseInt(createExpiry, 10);
			if (createExpiry && days > 0) body.expiresInDays = days;

			const result = await apiFetch<NewTokenResult>(`/api/workspaces/${workspaceSlug}/tokens`, {
				method: "POST",
				workspaceSlug,
				body,
			});
			setNewToken(result);
			await fetchTokens();
		} catch (e) {
			setCreateError(String(e));
		} finally {
			setCreating(false);
		}
	}

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard API unavailable; user can manually copy
		}
	}

	async function handleRevoke(id: string) {
		if (!workspaceSlug) return;
		setRevoking(true);
		setRevokeError(null);
		try {
			await apiFetch(`/api/workspaces/${workspaceSlug}/tokens/${id}`, {
				method: "DELETE",
				workspaceSlug,
			});
			setRevokeId(null);
			await fetchTokens();
		} catch (e) {
			setRevokeError(String(e));
		} finally {
			setRevoking(false);
		}
	}

	const origin = typeof window !== "undefined" ? window.location.origin : "";
	const mcpUrl = workspaceId ? `${origin}/mcp/${workspaceId}` : null;

	function mcpCommand(token: string) {
		if (mcpCommandTemplate) {
			return mcpCommandTemplate.replace("{{TOKEN}}", token);
		}
		if (!mcpUrl || !workspaceSlug) return "";
		return `claude mcp add --transport http \\\n  --header "Authorization: Bearer ${token}" \\\n  --header "X-Workspace-Slug: ${workspaceSlug}" \\\n  projektor "${mcpUrl}"`;
	}

	if (!workspaceSlug) {
		return <p class="text-text-muted">No workspace configured.</p>;
	}

	if (loading) return <p aria-live="polite">Loading tokens…</p>;

	if (forbidden) {
		return (
			<div class="p-4 bg-surface border border-border rounded-md text-text-muted">
				<strong>Access denied.</strong> Only workspace owners and admins can manage API tokens.
			</div>
		);
	}

	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load tokens: {error}
			</p>
		);
	}

	return (
		<div>
			{/* Header row */}
			<div class="flex justify-between items-center mb-5">
				<p class="m-0 text-sm text-text-muted">
					{tokens.length} token{tokens.length !== 1 ? "s" : ""}
				</p>
				{!showCreate && (
					<button type="button" onClick={openCreate} class="btn btn-primary btn-sm">
						+ New token
					</button>
				)}
			</div>

			{/* Create form */}
			{showCreate && (
				<div class="mb-6 px-5 py-4 bg-surface border border-border rounded-lg">
					{newToken ? (
						<div class="bg-surface border border-border rounded-md p-4 mt-4">
							<p class="m-0 mb-2 font-semibold text-[0.9rem] text-text-base">
								Token created:{" "}
								<span class="font-mono text-[0.8rem] text-text-muted">{newToken.name}</span>
							</p>
							<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
								⚠ Copy this token now — you won't be able to see it again.
							</p>
							<div class="flex items-center gap-2 my-2">
								<code class="flex-1 font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded text-text-base break-all">
									{newToken.token}
								</code>
								<button
									type="button"
									class="btn btn-outline btn-sm"
									onClick={() => copyToClipboard(newToken.token)}
								>
									Copy
								</button>
							</div>

							{(mcpCommandTemplate || mcpUrl) && (
								<div class="mt-4">
									<p class="m-0 mb-[0.375rem] text-[0.8rem] font-semibold text-text-muted">
										Connect to Claude:
									</p>
									<div class="font-mono text-xs px-3 py-2 bg-bg border border-border rounded text-text-muted break-all whitespace-pre-wrap leading-[1.6]">
										{mcpCommand(newToken.token)}
									</div>
									<button
										type="button"
										class="btn btn-outline btn-sm mt-2"
										onClick={() => copyToClipboard(mcpCommand(newToken.token))}
									>
										Copy command
									</button>
									<p class="m-0 mt-[0.375rem] text-xs text-text-muted">
										Run this command in your terminal to connect Claude Code to this workspace.
									</p>
								</div>
							)}

							<div class="mt-4">
								<button type="button" class="btn btn-outline btn-sm" onClick={closeCreate}>
									Done
								</button>
							</div>
						</div>
					) : (
						<form onSubmit={handleCreate}>
							<h3 class="m-0 mb-4 text-base font-semibold text-text-base">New API token</h3>

							<div class="flex flex-col gap-1 mb-[0.875rem]">
								<label class="text-[0.8rem] font-semibold text-text-muted" for="tok-name">
									Name *
								</label>
								<input
									ref={nameInputRef}
									id="tok-name"
									class="w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1"
									type="text"
									placeholder="e.g. Claude Code agent"
									value={createName}
									onInput={(e) => setCreateName((e.target as HTMLInputElement).value)}
									required
									maxLength={100}
								/>
							</div>

							<div class="flex flex-col gap-1 mb-[0.875rem]">
								<span class="text-[0.8rem] font-semibold text-text-muted">Scope</span>
								<div class="flex flex-col gap-[0.375rem]">
									<label class="flex items-center gap-2 cursor-pointer text-sm text-text-base">
										<input
											type="radio"
											name="scope"
											checked={createScope === "readwrite"}
											onChange={() => setCreateScope("readwrite")}
										/>
										Read + Write (recommended)
									</label>
									<label class="flex items-center gap-2 cursor-pointer text-sm text-text-base">
										<input
											type="radio"
											name="scope"
											checked={createScope === "read"}
											onChange={() => setCreateScope("read")}
										/>
										Read-only
									</label>
								</div>
							</div>

							<div class="flex flex-col gap-1 mb-[0.875rem]">
								<label class="text-[0.8rem] font-semibold text-text-muted" for="tok-expiry">
									Expires in (days, optional)
								</label>
								<input
									id="tok-expiry"
									class="w-full sm:max-w-[240px] px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1"
									type="number"
									min={1}
									max={365}
									placeholder="e.g. 90 (leave blank for no expiry)"
									value={createExpiry}
									onInput={(e) => setCreateExpiry((e.target as HTMLInputElement).value)}
								/>
							</div>

							{createError && (
								<p role="alert" class="text-[var(--danger-text)] text-[0.8rem] m-0 mb-3">
									{createError}
								</p>
							)}

							<div class="flex gap-2">
								<button
									type="submit"
									class="btn btn-primary btn-sm"
									disabled={creating || !createName.trim()}
								>
									{creating ? "Creating…" : "Create token"}
								</button>
								<button
									type="button"
									class="btn btn-outline btn-sm"
									onClick={closeCreate}
									disabled={creating}
								>
									Cancel
								</button>
							</div>
						</form>
					)}
				</div>
			)}

			{/* Token list */}
			{tokens.length === 0 ? (
				<div class="p-8 text-center text-text-muted bg-surface rounded-lg border border-border">
					<p class="m-0 mb-2">No API tokens yet.</p>
					<p class="m-0 text-sm">Create a token to allow agents and scripts to authenticate.</p>
				</div>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap">
									Name
								</th>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap">
									Scope
								</th>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap">
									Created
								</th>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap">
									Expires
								</th>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap">
									Last used
								</th>
								<th class="text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap"></th>
							</tr>
						</thead>
						<tbody>
							{tokens.map((tok) => (
								<tr key={tok.id}>
									<td class="px-3 py-2 border-b border-border align-middle text-text-base font-medium [tr:last-child_&]:border-b-0">
										{tok.name}
									</td>
									<td class="px-3 py-2 border-b border-border align-middle font-mono text-[0.8rem] text-text-muted [tr:last-child_&]:border-b-0">
										{formatScopes(tok.scopes)}
									</td>
									<td class="px-3 py-2 border-b border-border align-middle font-mono text-[0.8rem] text-text-muted [tr:last-child_&]:border-b-0">
										{formatDate(tok.createdAt)}
									</td>
									<td
										class={`px-3 py-2 border-b border-border align-middle font-mono text-[0.8rem] [tr:last-child_&]:border-b-0 ${
											tok.expiresAt && tok.expiresAt < Date.now() / 1000
												? "text-[var(--danger-text)]"
												: "text-text-muted"
										}`}
									>
										{tok.expiresAt === null ? "No expiry" : formatDate(tok.expiresAt)}
									</td>
									<td class="px-3 py-2 border-b border-border align-middle font-mono text-[0.8rem] text-text-muted [tr:last-child_&]:border-b-0">
										{formatDate(tok.lastUsedAt)}
									</td>
									<td class="px-3 py-2 border-b border-border align-middle whitespace-nowrap [tr:last-child_&]:border-b-0">
										{revokeId === tok.id ? (
											<span class="inline-flex gap-[0.375rem] items-center">
												<span class="text-[0.8rem] text-text-muted">Revoke?</span>
												<button
													type="button"
													class="btn btn-danger btn-sm"
													disabled={revoking}
													onClick={() => handleRevoke(tok.id)}
												>
													{revoking ? "…" : "Yes"}
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm"
													disabled={revoking}
													onClick={() => setRevokeId(null)}
												>
													No
												</button>
												{revokeError && (
													<span class="text-[var(--danger-text)] text-xs">{revokeError}</span>
												)}
											</span>
										) : (
											<button
												type="button"
												class="btn btn-outline btn-sm text-[var(--danger-text)] border-[var(--danger-border)]"
												onClick={() => {
													setRevokeId(tok.id);
													setRevokeError(null);
												}}
											>
												Revoke
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
