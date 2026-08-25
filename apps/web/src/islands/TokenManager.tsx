import { buildMcpAddCommandMultiline } from "@projektor/types";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { resolveWorkspaceSlug } from "../utils/workspace";
import { Button } from "./ui/Button";

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

type TokenScope = "read" | "readwrite";

const SCOPE_READ = ["read"];
const SCOPE_READWRITE = ["read", "write"];

const FORM_INPUT_CLASS =
	"px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";
const TOKEN_CODE_CLASS =
	"flex-1 font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded text-text-base break-all";
const MCP_COMMAND_CLASS =
	"font-mono text-xs px-3 py-2 bg-bg border border-border rounded text-text-muted break-all " +
	"whitespace-pre-wrap leading-[1.6]";
const TD_BASE = "px-3 py-2 border-b border-border align-middle [tr:last-child_&]:border-b-0";
const TD_MUTED = `${TD_BASE} font-mono text-[0.8rem] text-text-muted`;
const TH_CLASS =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

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

function buildMcpCommand(
	mcpCommandTemplate: string | null,
	mcpUrl: string | null,
	workspaceSlug: string,
	token: string
): string {
	if (mcpCommandTemplate) {
		return mcpCommandTemplate.replace("{{TOKEN}}", token);
	}
	if (!mcpUrl) return "";
	return buildMcpAddCommandMultiline({ workspaceSlug, mcpUrl, token });
}

async function copyToClipboard(text: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// Clipboard API unavailable; user can manually copy
	}
}

async function loadWorkspaceMeta(
	workspaceSlug: string,
	setWorkspaceId: (id: string) => void,
	setMcpCommandTemplate: (tpl: string) => void
) {
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
			{
				workspaceSlug,
			}
		);
		setMcpCommandTemplate(data.mcpAddCommandTemplate);
	} catch {
		// non-fatal
	}
}

interface FetchTokensSetters {
	setLoading: (v: boolean) => void;
	setError: (v: string | null) => void;
	setForbidden: (v: boolean) => void;
	setTokens: (v: ApiToken[]) => void;
}

async function fetchTokensRequest(workspaceSlug: string, setters: FetchTokensSetters) {
	setters.setLoading(true);
	setters.setError(null);
	setters.setForbidden(false);
	try {
		const data = await apiFetch<ApiToken[]>(`/api/workspaces/${workspaceSlug}/tokens`, {
			workspaceSlug,
		});
		setters.setTokens(Array.isArray(data) ? data : []);
	} catch (e) {
		if (String(e).includes(": 403")) {
			setters.setForbidden(true);
		} else {
			setters.setError(String(e));
		}
	} finally {
		setters.setLoading(false);
	}
}

function buildCreateTokenBody(
	name: string,
	scope: TokenScope,
	expiryDays: string
): Record<string, unknown> {
	const scopes = scope === "read" ? SCOPE_READ : SCOPE_READWRITE;
	const body: Record<string, unknown> = { name: name.trim(), scopes };
	const days = parseInt(expiryDays, 10);
	if (expiryDays && days > 0) body.expiresInDays = days;
	return body;
}

interface CreateTokenInput {
	workspaceSlug: string | undefined;
	name: string;
	scope: TokenScope;
	expiryDays: string;
}

interface CreateTokenSetters {
	setCreating: (v: boolean) => void;
	setCreateError: (v: string | null) => void;
	setNewToken: (v: NewTokenResult | null) => void;
}

async function performCreate(
	input: CreateTokenInput,
	setters: CreateTokenSetters,
	refetch: () => Promise<void>
) {
	const { workspaceSlug, name, scope, expiryDays } = input;
	if (!workspaceSlug || !name.trim()) return;
	setters.setCreating(true);
	setters.setCreateError(null);
	try {
		const body = buildCreateTokenBody(name, scope, expiryDays);
		const result = await apiFetch<NewTokenResult>(`/api/workspaces/${workspaceSlug}/tokens`, {
			method: "POST",
			workspaceSlug,
			body,
		});
		setters.setNewToken(result);
		await refetch();
	} catch (e) {
		setters.setCreateError(String(e));
	} finally {
		setters.setCreating(false);
	}
}

interface RevokeTokenSetters {
	setRevoking: (v: boolean) => void;
	setRevokeError: (v: string | null) => void;
	setRevokeId: (v: string | null) => void;
}

async function performRevoke(
	workspaceSlug: string | undefined,
	id: string,
	setters: RevokeTokenSetters,
	refetch: () => Promise<void>
) {
	if (!workspaceSlug) return;
	setters.setRevoking(true);
	setters.setRevokeError(null);
	try {
		await apiFetch(`/api/workspaces/${workspaceSlug}/tokens/${id}`, {
			method: "DELETE",
			workspaceSlug,
		});
		setters.setRevokeId(null);
		await refetch();
	} catch (e) {
		setters.setRevokeError(String(e));
	} finally {
		setters.setRevoking(false);
	}
}

interface NewTokenPanelProps {
	newToken: NewTokenResult;
	mcpCommandTemplate: string | null;
	mcpUrl: string | null;
	workspaceSlug: string;
	onDone: () => void;
}

function NewTokenPanel({
	newToken,
	mcpCommandTemplate,
	mcpUrl,
	workspaceSlug,
	onDone,
}: NewTokenPanelProps) {
	const command = buildMcpCommand(mcpCommandTemplate, mcpUrl, workspaceSlug, newToken.token);
	return (
		<div class="bg-surface border border-border rounded-md p-4 mt-4">
			<p class="m-0 mb-2 font-semibold text-[0.9rem] text-text-base">
				Token created: <span class="font-mono text-[0.8rem] text-text-muted">{newToken.name}</span>
			</p>
			<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
				⚠ Copy this token now — you won't be able to see it again.
			</p>
			<div class="flex items-center gap-2 my-2">
				<code class={TOKEN_CODE_CLASS}>{newToken.token}</code>
				<Button variant="outline" size="sm" onClick={() => copyToClipboard(newToken.token)}>
					Copy
				</Button>
			</div>

			{(mcpCommandTemplate || mcpUrl) && (
				<div class="mt-4">
					<p class="m-0 mb-[0.375rem] text-[0.8rem] font-semibold text-text-muted">
						Connect to Claude:
					</p>
					<div class={MCP_COMMAND_CLASS}>{command}</div>
					<Button variant="outline" size="sm" class="mt-2" onClick={() => copyToClipboard(command)}>
						Copy command
					</Button>
					<p class="m-0 mt-[0.375rem] text-xs text-text-muted">
						Run this command in your terminal to connect Claude Code to this workspace.
					</p>
				</div>
			)}

			<div class="mt-4">
				<Button variant="outline" size="sm" onClick={onDone}>
					Done
				</Button>
			</div>
		</div>
	);
}

interface CreateTokenFormProps {
	nameInputRef: { current: HTMLInputElement | null };
	createName: string;
	setCreateName: (v: string) => void;
	createScope: TokenScope;
	setCreateScope: (v: TokenScope) => void;
	createExpiry: string;
	setCreateExpiry: (v: string) => void;
	createError: string | null;
	creating: boolean;
	onSubmit: (e: Event) => void;
	onCancel: () => void;
}

function CreateTokenForm({
	nameInputRef,
	createName,
	setCreateName,
	createScope,
	setCreateScope,
	createExpiry,
	setCreateExpiry,
	createError,
	creating,
	onSubmit,
	onCancel,
}: CreateTokenFormProps) {
	return (
		<form onSubmit={onSubmit}>
			<h3 class="m-0 mb-4 text-base font-semibold text-text-base">New API token</h3>

			<div class="flex flex-col gap-1 mb-[0.875rem]">
				<label class="text-[0.8rem] font-semibold text-text-muted" for="tok-name">
					Name *
				</label>
				<input
					ref={nameInputRef}
					id="tok-name"
					class={`w-full ${FORM_INPUT_CLASS}`}
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
					class={`w-full sm:max-w-[240px] ${FORM_INPUT_CLASS}`}
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
				<Button type="submit" variant="primary" size="sm" disabled={creating || !createName.trim()}>
					{creating ? "Creating…" : "Create token"}
				</Button>
				<Button variant="outline" size="sm" onClick={onCancel} disabled={creating}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

interface CreateTokenSectionProps {
	newToken: NewTokenResult | null;
	mcpCommandTemplate: string | null;
	mcpUrl: string | null;
	workspaceSlug: string;
	nameInputRef: { current: HTMLInputElement | null };
	createName: string;
	setCreateName: (v: string) => void;
	createScope: TokenScope;
	setCreateScope: (v: TokenScope) => void;
	createExpiry: string;
	setCreateExpiry: (v: string) => void;
	createError: string | null;
	creating: boolean;
	onSubmit: (e: Event) => void;
	onCancel: () => void;
	onDone: () => void;
}

function CreateTokenSection(props: CreateTokenSectionProps) {
	return (
		<div class="mb-6 px-5 py-4 bg-surface border border-border rounded-lg">
			{props.newToken ? (
				<NewTokenPanel
					newToken={props.newToken}
					mcpCommandTemplate={props.mcpCommandTemplate}
					mcpUrl={props.mcpUrl}
					workspaceSlug={props.workspaceSlug}
					onDone={props.onDone}
				/>
			) : (
				<CreateTokenForm
					nameInputRef={props.nameInputRef}
					createName={props.createName}
					setCreateName={props.setCreateName}
					createScope={props.createScope}
					setCreateScope={props.setCreateScope}
					createExpiry={props.createExpiry}
					setCreateExpiry={props.setCreateExpiry}
					createError={props.createError}
					creating={props.creating}
					onSubmit={props.onSubmit}
					onCancel={props.onCancel}
				/>
			)}
		</div>
	);
}

interface TokenTableRowProps {
	tok: ApiToken;
	revokeId: string | null;
	revoking: boolean;
	revokeError: string | null;
	onSelectRevoke: (id: string) => void;
	onCancelRevoke: () => void;
	onConfirmRevoke: (id: string) => void;
}

function TokenTableRow({
	tok,
	revokeId,
	revoking,
	revokeError,
	onSelectRevoke,
	onCancelRevoke,
	onConfirmRevoke,
}: TokenTableRowProps) {
	const expiresClass = `${TD_BASE} font-mono text-[0.8rem] ${
		tok.expiresAt && tok.expiresAt < Date.now() / 1000
			? "text-[var(--danger-text)]"
			: "text-text-muted"
	}`;
	return (
		<tr>
			<td class={`${TD_BASE} text-text-base font-medium`}>{tok.name}</td>
			<td class={TD_MUTED}>{formatScopes(tok.scopes)}</td>
			<td class={TD_MUTED}>{formatDate(tok.createdAt)}</td>
			<td class={expiresClass}>
				{tok.expiresAt === null ? "No expiry" : formatDate(tok.expiresAt)}
			</td>
			<td class={TD_MUTED}>{formatDate(tok.lastUsedAt)}</td>
			<td class={`${TD_BASE} whitespace-nowrap`}>
				<TokenRevokeControl
					tok={tok}
					revokeId={revokeId}
					revoking={revoking}
					revokeError={revokeError}
					onSelectRevoke={onSelectRevoke}
					onCancelRevoke={onCancelRevoke}
					onConfirmRevoke={onConfirmRevoke}
				/>
			</td>
		</tr>
	);
}

function TokenRevokeControl({
	tok,
	revokeId,
	revoking,
	revokeError,
	onSelectRevoke,
	onCancelRevoke,
	onConfirmRevoke,
}: TokenTableRowProps) {
	if (revokeId === tok.id) {
		return (
			<span class="inline-flex gap-[0.375rem] items-center flex-wrap">
				<span class="text-[0.8rem] text-text-muted">Revoke?</span>
				<Button
					variant="danger"
					size="sm"
					disabled={revoking}
					onClick={() => onConfirmRevoke(tok.id)}
				>
					{revoking ? "…" : "Yes"}
				</Button>
				<Button variant="outline" size="sm" disabled={revoking} onClick={onCancelRevoke}>
					No
				</Button>
				{revokeError && <span class="text-[var(--danger-text)] text-xs">{revokeError}</span>}
			</span>
		);
	}
	return (
		<Button
			variant="outline"
			size="sm"
			class="text-[var(--danger-text)] border-[var(--danger-border)]"
			onClick={() => onSelectRevoke(tok.id)}
		>
			Revoke
		</Button>
	);
}

function TokenMobileCards({
	tokens,
	revokeId,
	revoking,
	revokeError,
	onSelectRevoke,
	onCancelRevoke,
	onConfirmRevoke,
}: TokenTableProps) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{tokens.map((tok) => (
				<div key={tok.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="text-[0.9rem] text-text-base font-medium mb-2">{tok.name}</div>
					<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[0.8rem] text-text-muted mb-3">
						<dt class="font-semibold">Scope</dt>
						<dd class="m-0">{formatScopes(tok.scopes)}</dd>
						<dt class="font-semibold">Created</dt>
						<dd class="m-0">{formatDate(tok.createdAt)}</dd>
						<dt class="font-semibold">Expires</dt>
						<dd
							class={`m-0 ${tok.expiresAt && tok.expiresAt < Date.now() / 1000 ? "text-[var(--danger-text)]" : ""}`}
						>
							{tok.expiresAt === null ? "No expiry" : formatDate(tok.expiresAt)}
						</dd>
						<dt class="font-semibold">Last used</dt>
						<dd class="m-0">{formatDate(tok.lastUsedAt)}</dd>
					</dl>
					<TokenRevokeControl
						tok={tok}
						revokeId={revokeId}
						revoking={revoking}
						revokeError={revokeError}
						onSelectRevoke={onSelectRevoke}
						onCancelRevoke={onCancelRevoke}
						onConfirmRevoke={onConfirmRevoke}
					/>
				</div>
			))}
		</div>
	);
}

interface TokenTableProps {
	tokens: ApiToken[];
	revokeId: string | null;
	revoking: boolean;
	revokeError: string | null;
	onSelectRevoke: (id: string) => void;
	onCancelRevoke: () => void;
	onConfirmRevoke: (id: string) => void;
}

function TokenTable({
	tokens,
	revokeId,
	revoking,
	revokeError,
	onSelectRevoke,
	onCancelRevoke,
	onConfirmRevoke,
}: TokenTableProps) {
	if (tokens.length === 0) {
		return (
			<div class="p-8 text-center text-text-muted bg-surface rounded-lg border border-border">
				<p class="m-0 mb-2">No API tokens yet.</p>
				<p class="m-0 text-sm">Create a token to allow agents and scripts to authenticate.</p>
			</div>
		);
	}
	return (
		<>
			<div class="overflow-x-auto max-sm:hidden">
				<table class="w-full border-collapse text-[0.9rem]">
					<thead>
						<tr>
							<th class={TH_CLASS}>Name</th>
							<th class={TH_CLASS}>Scope</th>
							<th class={TH_CLASS}>Created</th>
							<th class={TH_CLASS}>Expires</th>
							<th class={TH_CLASS}>Last used</th>
							<th class={TH_CLASS}></th>
						</tr>
					</thead>
					<tbody>
						{tokens.map((tok) => (
							<TokenTableRow
								key={tok.id}
								tok={tok}
								revokeId={revokeId}
								revoking={revoking}
								revokeError={revokeError}
								onSelectRevoke={onSelectRevoke}
								onCancelRevoke={onCancelRevoke}
								onConfirmRevoke={onConfirmRevoke}
							/>
						))}
					</tbody>
				</table>
			</div>
			<TokenMobileCards
				tokens={tokens}
				revokeId={revokeId}
				revoking={revoking}
				revokeError={revokeError}
				onSelectRevoke={onSelectRevoke}
				onCancelRevoke={onCancelRevoke}
				onConfirmRevoke={onConfirmRevoke}
			/>
		</>
	);
}

interface TokenManagerContentProps {
	tokens: ApiToken[];
	showCreate: boolean;
	openCreate: () => void;
	newToken: NewTokenResult | null;
	mcpCommandTemplate: string | null;
	mcpUrl: string | null;
	workspaceSlug: string;
	nameInputRef: { current: HTMLInputElement | null };
	createName: string;
	setCreateName: (v: string) => void;
	createScope: TokenScope;
	setCreateScope: (v: TokenScope) => void;
	createExpiry: string;
	setCreateExpiry: (v: string) => void;
	createError: string | null;
	creating: boolean;
	onSubmit: (e: Event) => void;
	closeCreate: () => void;
	revokeId: string | null;
	revoking: boolean;
	revokeError: string | null;
	onSelectRevoke: (id: string) => void;
	onCancelRevoke: () => void;
	onConfirmRevoke: (id: string) => void;
}

function TokenManagerContent({
	tokens,
	showCreate,
	openCreate,
	newToken,
	mcpCommandTemplate,
	mcpUrl,
	workspaceSlug,
	nameInputRef,
	createName,
	setCreateName,
	createScope,
	setCreateScope,
	createExpiry,
	setCreateExpiry,
	createError,
	creating,
	onSubmit,
	closeCreate,
	revokeId,
	revoking,
	revokeError,
	onSelectRevoke,
	onCancelRevoke,
	onConfirmRevoke,
}: TokenManagerContentProps) {
	return (
		<div>
			<div class="flex justify-between items-center mb-5">
				<p class="m-0 text-sm text-text-muted">
					{tokens.length} token{tokens.length !== 1 ? "s" : ""}
				</p>
				{!showCreate && (
					<Button variant="primary" size="sm" onClick={openCreate}>
						+ New token
					</Button>
				)}
			</div>

			{showCreate && (
				<CreateTokenSection
					newToken={newToken}
					mcpCommandTemplate={mcpCommandTemplate}
					mcpUrl={mcpUrl}
					workspaceSlug={workspaceSlug}
					nameInputRef={nameInputRef}
					createName={createName}
					setCreateName={setCreateName}
					createScope={createScope}
					setCreateScope={setCreateScope}
					createExpiry={createExpiry}
					setCreateExpiry={setCreateExpiry}
					createError={createError}
					creating={creating}
					onSubmit={onSubmit}
					onCancel={closeCreate}
					onDone={closeCreate}
				/>
			)}

			<TokenTable
				tokens={tokens}
				revokeId={revokeId}
				revoking={revoking}
				revokeError={revokeError}
				onSelectRevoke={onSelectRevoke}
				onCancelRevoke={onCancelRevoke}
				onConfirmRevoke={onConfirmRevoke}
			/>
		</div>
	);
}

function useWorkspaceMcpMeta(workspaceSlug: string | undefined) {
	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [mcpCommandTemplate, setMcpCommandTemplate] = useState<string | null>(null);

	useEffect(() => {
		if (workspaceSlug) {
			loadWorkspaceMeta(workspaceSlug, setWorkspaceId, setMcpCommandTemplate);
		}
	}, [workspaceSlug]);

	const origin = typeof window !== "undefined" ? window.location.origin : "";
	const mcpUrl = workspaceId ? `${origin}/mcp/${workspaceId}` : null;

	return { mcpCommandTemplate, mcpUrl };
}

export default function TokenManager({ workspaceSlug: propWorkspaceSlug }: Props) {
	const workspaceSlug = resolveWorkspaceSlug(propWorkspaceSlug);
	const [tokens, setTokens] = useState<ApiToken[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);

	const { mcpCommandTemplate, mcpUrl } = useWorkspaceMcpMeta(workspaceSlug);

	const [showCreate, setShowCreate] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createScope, setCreateScope] = useState<TokenScope>("readwrite");
	const [createExpiry, setCreateExpiry] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [newToken, setNewToken] = useState<NewTokenResult | null>(null);

	const [revokeId, setRevokeId] = useState<string | null>(null);
	const [revoking, setRevoking] = useState(false);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	const nameInputRef = useRef<HTMLInputElement>(null);

	const fetchTokens = useCallback(async () => {
		if (!workspaceSlug) return;
		await fetchTokensRequest(workspaceSlug, { setLoading, setError, setForbidden, setTokens });
	}, [workspaceSlug]);

	useEffect(() => {
		fetchTokens();
	}, [fetchTokens]);

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

	function handleCreate(e: Event) {
		e.preventDefault();
		performCreate(
			{ workspaceSlug, name: createName, scope: createScope, expiryDays: createExpiry },
			{ setCreating, setCreateError, setNewToken },
			fetchTokens
		);
	}

	function handleRevoke(id: string) {
		performRevoke(workspaceSlug, id, { setRevoking, setRevokeError, setRevokeId }, fetchTokens);
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
		<TokenManagerContent
			tokens={tokens}
			showCreate={showCreate}
			openCreate={openCreate}
			newToken={newToken}
			mcpCommandTemplate={mcpCommandTemplate}
			mcpUrl={mcpUrl}
			workspaceSlug={workspaceSlug}
			nameInputRef={nameInputRef}
			createName={createName}
			setCreateName={setCreateName}
			createScope={createScope}
			setCreateScope={setCreateScope}
			createExpiry={createExpiry}
			setCreateExpiry={setCreateExpiry}
			createError={createError}
			creating={creating}
			onSubmit={handleCreate}
			closeCreate={closeCreate}
			revokeId={revokeId}
			revoking={revoking}
			revokeError={revokeError}
			onSelectRevoke={(id) => {
				setRevokeId(id);
				setRevokeError(null);
			}}
			onCancelRevoke={() => setRevokeId(null)}
			onConfirmRevoke={handleRevoke}
		/>
	);
}
