import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

type GrantRole = "viewer" | "member" | "admin";

interface GroupSummary {
	id: string;
	name: string;
	description: string | null;
	memberCount: number;
	grantCount: number;
}

interface GroupMemberRow {
	userId: string;
	email: string;
	name: string;
}

interface GroupGrantRow {
	projectId: string;
	projectName: string;
	projectKey: string;
	role: GrantRole;
}

interface GroupDetail extends GroupSummary {
	members: GroupMemberRow[];
	grants: GroupGrantRow[];
}

interface WsMember {
	id: string;
	email: string;
	name: string;
	role: string;
}

interface MemberGroupsRow {
	userId: string;
	groups: Array<{ id: string; name: string }>;
}

interface ProjectLite {
	id: string;
	name: string;
	key: string;
}

interface Props {
	workspaceSlug?: string;
}

const GRANT_ROLES: GrantRole[] = ["viewer", "member", "admin"];

const BTN_PRIMARY =
	"px-3 py-[0.4rem] rounded text-[0.8rem] font-semibold bg-accent text-white border border-accent " +
	"cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY =
	"px-3 py-[0.4rem] rounded text-[0.8rem] font-semibold bg-bg text-text-base border border-border " +
	"cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DANGER =
	"px-2 py-[0.3rem] rounded text-[0.75rem] font-semibold bg-transparent text-[var(--danger-text)] border border-border " +
	"cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const INPUT =
	"px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.85rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";
const CARD = "border border-border rounded-lg bg-surface p-4 mb-4";
const CHIP =
	"inline-flex items-center px-2 py-[0.1rem] mr-1 mb-1 rounded-full text-[0.72rem] " +
	"bg-bg border border-border text-text-base";
const BADGE_PENDING =
	"inline-flex items-center px-2 py-[0.1rem] rounded-full text-[0.72rem] " +
	"bg-[var(--priority-low-bg)] text-text-muted border border-border";
const TH =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base text-[0.8rem]";
const TD =
	"px-3 py-2 border-b border-border align-middle text-[0.85rem] [tr:last-child_&]:border-b-0";
const H2 = "text-[1.05rem] font-bold text-text-base m-0 mb-3";

function isForbidden(e: unknown): boolean {
	return String(e).includes(": 403");
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

interface Loaded {
	groups: GroupSummary[];
	members: WsMember[];
	memberGroups: MemberGroupsRow[];
	projects: ProjectLite[];
}

async function loadAll(slug: string): Promise<Loaded> {
	const [groups, ws, memberGroups, projects] = await Promise.all([
		apiFetch<GroupSummary[]>(`/api/workspaces/${slug}/groups`, { workspaceSlug: slug }),
		apiFetch<{ members: WsMember[] }>(`/api/workspaces/${slug}`, { workspaceSlug: slug }),
		apiFetch<MemberGroupsRow[]>(`/api/workspaces/${slug}/member-groups`, { workspaceSlug: slug }),
		apiFetch<ProjectLite[]>("/api/projects", { workspaceSlug: slug }),
	]);
	return { groups, members: ws.members ?? [], memberGroups, projects };
}

// ---------------------------------------------------------------------------
// Members overview — group chips + pending badge
// ---------------------------------------------------------------------------

function MembersOverview(props: { members: WsMember[]; memberGroups: MemberGroupsRow[] }) {
	const groupsByUser = new Map(props.memberGroups.map((r) => [r.userId, r.groups]));
	return (
		<section class={CARD}>
			<h2 class={H2}>Members</h2>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse">
					<thead>
						<tr>
							<th class={TH}>Member</th>
							<th class={TH}>Workspace role</th>
							<th class={TH}>Groups</th>
						</tr>
					</thead>
					<tbody>
						{props.members.map((m) => {
							const isAdmin = m.role === "owner" || m.role === "admin";
							const groups = groupsByUser.get(m.id) ?? [];
							return (
								<tr key={m.id}>
									<td class={TD}>
										<div class="font-medium text-text-base">{m.name || m.email}</div>
										<div class="text-[0.75rem] text-text-muted">{m.email}</div>
									</td>
									<td class={TD}>{m.role}</td>
									<td class={TD}>
										{isAdmin ? (
											<span class="text-[0.78rem] text-text-muted">
												All projects (bypasses groups)
											</span>
										) : groups.length > 0 ? (
											groups.map((g) => (
												<span key={g.id} class={CHIP}>
													{g.name}
												</span>
											))
										) : (
											<span class={BADGE_PENDING}>Pending — no access</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Group detail editor — rename, members, grants
// ---------------------------------------------------------------------------

interface DetailProps {
	slug: string;
	groupId: string;
	members: WsMember[];
	projects: ProjectLite[];
	onChanged: () => Promise<void>;
	onClose: () => void;
}

function GroupDetailEditor(props: DetailProps) {
	const { slug, groupId } = props;
	const [detail, setDetail] = useState<GroupDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [addUserId, setAddUserId] = useState("");
	const [grantProjectId, setGrantProjectId] = useState("");
	const [grantRole, setGrantRole] = useState<GrantRole>("member");

	const refetch = useCallback(async () => {
		try {
			const d = await apiFetch<GroupDetail>(`/api/workspaces/${slug}/groups/${groupId}`, {
				workspaceSlug: slug,
			});
			setDetail(d);
		} catch (e) {
			setErr(String(e));
		}
	}, [slug, groupId]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	async function run(fn: () => Promise<void>) {
		setBusy(true);
		setErr(null);
		try {
			await fn();
			await refetch();
			await props.onChanged();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	if (!detail) {
		return (
			<div class={CARD}>
				{err ? <span class="text-[var(--danger-text)]">{err}</span> : "Loading…"}
			</div>
		);
	}

	const memberIds = new Set(detail.members.map((m) => m.userId));
	const addable = props.members.filter(
		(m) => !memberIds.has(m.id) && m.role !== "owner" && m.role !== "admin"
	);
	const grantedIds = new Set(detail.grants.map((g) => g.projectId));
	const grantable = props.projects.filter((p) => !grantedIds.has(p.id));

	return (
		<section class={CARD}>
			<div class="flex items-center justify-between mb-3">
				<h2 class={H2} style="margin-bottom:0;">
					{detail.name}
				</h2>
				<button type="button" class={BTN_SECONDARY} onClick={props.onClose}>
					Close
				</button>
			</div>
			{err && <div class="text-[var(--danger-text)] text-[0.8rem] mb-2">{err}</div>}

			<h3 class="text-[0.85rem] font-semibold text-text-base mb-2">Members</h3>
			<div class="mb-2">
				{detail.members.length === 0 && (
					<div class="text-[0.8rem] text-text-muted mb-2">No members yet.</div>
				)}
				{detail.members.map((m) => (
					<div key={m.userId} class="flex items-center gap-2 mb-1">
						<span class={CHIP} style="margin:0;">
							{m.name || m.email}
						</span>
						<button
							type="button"
							class={BTN_DANGER}
							disabled={busy}
							onClick={() =>
								run(async () => {
									await apiFetch(`/api/workspaces/${slug}/groups/${groupId}/members/${m.userId}`, {
										method: "DELETE",
										workspaceSlug: slug,
									});
								})
							}
						>
							Remove
						</button>
					</div>
				))}
			</div>
			<div class="flex items-center gap-2 mb-4">
				<select
					class={INPUT}
					value={addUserId}
					onChange={(e) => setAddUserId((e.target as HTMLSelectElement).value)}
				>
					<option value="">Add a member…</option>
					{addable.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name || m.email}
						</option>
					))}
				</select>
				<button
					type="button"
					class={BTN_PRIMARY}
					disabled={busy || !addUserId}
					onClick={() =>
						run(async () => {
							await apiFetch(`/api/workspaces/${slug}/groups/${groupId}/members`, {
								method: "POST",
								workspaceSlug: slug,
								body: { userId: addUserId },
							});
							setAddUserId("");
						})
					}
				>
					Add
				</button>
			</div>

			<h3 class="text-[0.85rem] font-semibold text-text-base mb-2">Project grants</h3>
			<div class="mb-2">
				{detail.grants.length === 0 && (
					<div class="text-[0.8rem] text-text-muted mb-2">
						No grants — this group opens no projects.
					</div>
				)}
				{detail.grants.map((g) => (
					<div key={g.projectId} class="flex items-center gap-2 mb-1">
						<span class="text-[0.82rem] text-text-base min-w-[9rem]">
							{g.projectName} <span class="text-text-muted">({g.projectKey})</span>
						</span>
						<select
							class={INPUT}
							value={g.role}
							disabled={busy}
							onChange={(e) =>
								run(async () => {
									await apiFetch(`/api/workspaces/${slug}/groups/${groupId}/grants`, {
										method: "PUT",
										workspaceSlug: slug,
										body: { projectId: g.projectId, role: (e.target as HTMLSelectElement).value },
									});
								})
							}
						>
							{GRANT_ROLES.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
						<button
							type="button"
							class={BTN_DANGER}
							disabled={busy}
							onClick={() =>
								run(async () => {
									await apiFetch(
										`/api/workspaces/${slug}/groups/${groupId}/grants/${g.projectId}`,
										{ method: "DELETE", workspaceSlug: slug }
									);
								})
							}
						>
							Remove
						</button>
					</div>
				))}
			</div>
			<div class="flex items-center gap-2">
				<select
					class={INPUT}
					value={grantProjectId}
					onChange={(e) => setGrantProjectId((e.target as HTMLSelectElement).value)}
				>
					<option value="">Grant a project…</option>
					{grantable.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name} ({p.key})
						</option>
					))}
				</select>
				<select
					class={INPUT}
					value={grantRole}
					onChange={(e) => setGrantRole((e.target as HTMLSelectElement).value as GrantRole)}
				>
					{GRANT_ROLES.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
				<button
					type="button"
					class={BTN_PRIMARY}
					disabled={busy || !grantProjectId}
					onClick={() =>
						run(async () => {
							await apiFetch(`/api/workspaces/${slug}/groups/${groupId}/grants`, {
								method: "PUT",
								workspaceSlug: slug,
								body: { projectId: grantProjectId, role: grantRole },
							});
							setGrantProjectId("");
							setGrantRole("member");
						})
					}
				>
					Grant
				</button>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

// cofferdam-ignore: Readability.MaxFunctionLength: single-island admin screen, normal preact style
export default function GroupManager({ workspaceSlug }: Props) {
	const slug = workspaceSlug ?? "";
	const [data, setData] = useState<Loaded | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [createErr, setCreateErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refetch = useCallback(async () => {
		if (!slug) return;
		setLoading(true);
		setError(null);
		setForbidden(false);
		try {
			setData(await loadAll(slug));
		} catch (e) {
			if (isForbidden(e)) setForbidden(true);
			else setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [slug]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	if (!slug) return <div class={CARD}>No workspace configured.</div>;
	if (loading) return <div class={CARD}>Loading…</div>;
	if (forbidden) return <div class={CARD}>Only workspace owners and admins can manage groups.</div>;
	if (error) return <div class={CARD}>Error: {error}</div>;
	if (!data) return null;

	async function createGroup() {
		const name = newName.trim();
		if (!name) return;
		setBusy(true);
		setCreateErr(null);
		try {
			await apiFetch(`/api/workspaces/${slug}/groups`, {
				method: "POST",
				workspaceSlug: slug,
				body: { name },
			});
			setNewName("");
			await refetch();
		} catch (e) {
			setCreateErr(isForbidden(e) ? "Only admins can create groups." : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function deleteGroup(id: string) {
		setBusy(true);
		try {
			await apiFetch(`/api/workspaces/${slug}/groups/${id}`, {
				method: "DELETE",
				workspaceSlug: slug,
			});
			if (selected === id) setSelected(null);
			await refetch();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<MembersOverview members={data.members} memberGroups={data.memberGroups} />

			<section class={CARD}>
				<h2 class={H2}>Groups</h2>
				<div class="flex items-center gap-2 mb-4">
					<input
						class={INPUT}
						placeholder="New group name"
						value={newName}
						onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void createGroup();
						}}
					/>
					<button
						type="button"
						class={BTN_PRIMARY}
						disabled={busy || !newName.trim()}
						onClick={createGroup}
					>
						Create group
					</button>
				</div>
				{createErr && <div class="text-[var(--danger-text)] text-[0.8rem] mb-2">{createErr}</div>}

				{data.groups.length === 0 ? (
					<div class="text-[0.85rem] text-text-muted">No groups yet.</div>
				) : (
					<div class="overflow-x-auto">
						<table class="w-full border-collapse">
							<thead>
								<tr>
									<th class={TH}>Name</th>
									<th class={TH}>Members</th>
									<th class={TH}>Projects</th>
									<th class={TH} />
								</tr>
							</thead>
							<tbody>
								{data.groups.map((g) => (
									<tr key={g.id}>
										<td class={TD}>
											<button
												type="button"
												class="text-accent font-medium bg-transparent border-0 cursor-pointer p-0"
												onClick={() => setSelected(g.id)}
											>
												{g.name}
											</button>
										</td>
										<td class={TD}>{g.memberCount}</td>
										<td class={TD}>{g.grantCount}</td>
										<td class={TD}>
											<button
												type="button"
												class={BTN_DANGER}
												disabled={busy}
												onClick={() => deleteGroup(g.id)}
											>
												Delete
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{selected && (
				<GroupDetailEditor
					slug={slug}
					groupId={selected}
					members={data.members}
					projects={data.projects}
					onChanged={refetch}
					onClose={() => setSelected(null)}
				/>
			)}
		</div>
	);
}
