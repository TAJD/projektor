import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { resolveWorkspaceSlug } from "../utils/workspace";
import { Button } from "./ui/Button";

// PROJ-659: connector grants — the OAuth authorizations a user hands to Claude and
// similar clients. Deliberately a separate island from TokenManager rather than another
// section inside it: API tokens are workspace property and admin-only, while a grant is
// personal, so every member must see this list even when the token list 403s at them.

interface ConnectorGrant {
	id: string;
	client: string;
	clientId: string;
	scopes: string[];
	grantedAt: number;
	expiresAt: number | null;
}

interface Props {
	workspaceSlug?: string;
}

const TD_BASE = "px-3 py-2 border-b border-border align-middle [tr:last-child_&]:border-b-0";
const TD_MUTED = `${TD_BASE} font-mono text-[0.8rem] text-text-muted`;
const TH_CLASS =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function formatDate(ts: number | null): string {
	if (ts === null) return "Never";
	return new Date(ts * 1000).toLocaleDateString();
}

// Grant scopes are the OAuth names (`projektor:read`), not the `pk_` token's bare
// `read`/`write`, so match on the suffix rather than reusing TokenManager's helper.
function formatScopes(scopes: string[]): string {
	if (scopes.some((scope) => scope.endsWith(":write"))) return "Read + Write";
	if (scopes.some((scope) => scope.endsWith(":read"))) return "Read-only";
	return scopes.join(", ") || "—";
}

interface RevokeState {
	revokeId: string | null;
	revoking: boolean;
	revokeError: string | null;
	onSelect: (id: string) => void;
	onCancel: () => void;
	onConfirm: (id: string) => void;
}

function RevokeControl({ id, state }: { id: string; state: RevokeState }) {
	if (state.revokeId === id) {
		return (
			<span class="inline-flex gap-[0.375rem] items-center flex-wrap">
				<span class="text-[0.8rem] text-text-muted">Disconnect?</span>
				<Button
					variant="danger"
					size="sm"
					disabled={state.revoking}
					onClick={() => state.onConfirm(id)}
				>
					{state.revoking ? "…" : "Yes"}
				</Button>
				<Button variant="outline" size="sm" disabled={state.revoking} onClick={state.onCancel}>
					No
				</Button>
				{state.revokeError && (
					<span class="text-[var(--danger-text)] text-xs">{state.revokeError}</span>
				)}
			</span>
		);
	}
	return (
		<Button
			variant="outline"
			size="sm"
			class="text-[var(--danger-text)] border-[var(--danger-border)]"
			onClick={() => state.onSelect(id)}
		>
			Disconnect
		</Button>
	);
}

function ConnectorTable({ grants, state }: { grants: ConnectorGrant[]; state: RevokeState }) {
	return (
		<div class="overflow-x-auto max-sm:hidden">
			<table class="w-full border-collapse text-[0.9rem]">
				<thead>
					<tr>
						<th class={TH_CLASS}>Application</th>
						<th class={TH_CLASS}>Access</th>
						<th class={TH_CLASS}>Connected</th>
						<th class={TH_CLASS}>Expires</th>
						<th class={TH_CLASS}></th>
					</tr>
				</thead>
				<tbody>
					{grants.map((grant) => (
						<tr key={grant.id}>
							<td class={`${TD_BASE} text-text-base font-medium`}>{grant.client}</td>
							<td class={TD_MUTED}>{formatScopes(grant.scopes)}</td>
							<td class={TD_MUTED}>{formatDate(grant.grantedAt)}</td>
							<td class={TD_MUTED}>
								{grant.expiresAt === null ? "No expiry" : formatDate(grant.expiresAt)}
							</td>
							<td class={`${TD_BASE} whitespace-nowrap`}>
								<RevokeControl id={grant.id} state={state} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function ConnectorCards({ grants, state }: { grants: ConnectorGrant[]; state: RevokeState }) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{grants.map((grant) => (
				<div key={grant.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="text-[0.9rem] text-text-base font-medium mb-2">{grant.client}</div>
					<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[0.8rem] text-text-muted mb-3">
						<dt class="font-semibold">Access</dt>
						<dd class="m-0">{formatScopes(grant.scopes)}</dd>
						<dt class="font-semibold">Connected</dt>
						<dd class="m-0">{formatDate(grant.grantedAt)}</dd>
						<dt class="font-semibold">Expires</dt>
						<dd class="m-0">
							{grant.expiresAt === null ? "No expiry" : formatDate(grant.expiresAt)}
						</dd>
					</dl>
					<RevokeControl id={grant.id} state={state} />
				</div>
			))}
		</div>
	);
}

export default function ConnectorManager({ workspaceSlug: propWorkspaceSlug }: Props) {
	const workspaceSlug = resolveWorkspaceSlug(propWorkspaceSlug);
	const [grants, setGrants] = useState<ConnectorGrant[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const [revokeId, setRevokeId] = useState<string | null>(null);
	const [revoking, setRevoking] = useState(false);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	const fetchGrants = useCallback(async () => {
		if (!workspaceSlug) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<ConnectorGrant[]>(`/api/workspaces/${workspaceSlug}/connectors`, {
				workspaceSlug,
			});
			setGrants(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [workspaceSlug]);

	useEffect(() => {
		fetchGrants();
	}, [fetchGrants]);

	async function handleRevoke(id: string) {
		if (!workspaceSlug) return;
		setRevoking(true);
		setRevokeError(null);
		try {
			await apiFetch(`/api/workspaces/${workspaceSlug}/connectors/${id}`, {
				method: "DELETE",
				workspaceSlug,
			});
			setRevokeId(null);
			await fetchGrants();
		} catch (e) {
			setRevokeError(String(e));
		} finally {
			setRevoking(false);
		}
	}

	const state: RevokeState = {
		revokeId,
		revoking,
		revokeError,
		onSelect: (id) => {
			setRevokeId(id);
			setRevokeError(null);
		},
		onCancel: () => setRevokeId(null),
		onConfirm: handleRevoke,
	};

	if (!workspaceSlug) return null;
	if (loading) return <p aria-live="polite">Loading connected applications…</p>;

	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load connected applications: {error}
			</p>
		);
	}

	if (grants.length === 0) {
		return (
			<div class="p-8 text-center text-text-muted bg-surface rounded-lg border border-border">
				<p class="m-0 mb-2">No connected applications.</p>
				<p class="m-0 text-sm">
					Add this workspace as a connector in Claude to authorize one — it will appear here, and
					you can withdraw it at any time.
				</p>
			</div>
		);
	}

	return (
		<div>
			<p class="m-0 mb-5 text-sm text-text-muted">
				{grants.length} connected application{grants.length !== 1 ? "s" : ""}
			</p>
			<ConnectorTable grants={grants} state={state} />
			<ConnectorCards grants={grants} state={state} />
		</div>
	);
}
