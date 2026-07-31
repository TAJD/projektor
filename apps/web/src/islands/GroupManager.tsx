import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { resolveWorkspaceSlug } from "../utils/workspace";

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
const INFO =
	"flex items-center gap-2 border border-border rounded-lg bg-bg px-4 py-3 mb-4 text-[0.82rem] text-text-base";
const ROLE_TAG =
	"inline-flex items-center px-2 py-[0.1rem] rounded-full text-[0.72rem] font-semibold " +
	"bg-accent text-white uppercase tracking-wide";
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
const TAB_LIST = "flex gap-1 border-b border-border mb-4";
const tabBtnClass = (active: boolean) =>
	"px-4 py-2 text-[0.85rem] font-semibold border-b-2 -mb-px bg-transparent cursor-pointer " +
	(active
		? "border-accent text-text-base"
		: "border-transparent text-text-muted hover:text-text-base");

type TabId = "members" | "groups";

const TAB_LABELS: Record<TabId, string> = { members: "Members", groups: "Groups" };

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
	role: string;
	isAdmin: boolean;
}

async function loadAll(slug: string): Promise<Loaded> {
	const [groups, ws, projects] = await Promise.all([
		apiFetch<GroupSummary[]>(`/api/workspaces/${slug}/groups`, { workspaceSlug: slug }),
		apiFetch<{ members: WsMember[]; currentUserRole: string }>(`/api/workspaces/${slug}`, {
			workspaceSlug: slug,
		}),
		apiFetch<ProjectLite[]>("/api/projects", { workspaceSlug: slug }),
	]);
	const role = ws.currentUserRole;
	const isAdmin = role === "owner" || role === "admin";
	// member-groups is admin-only; skip it for non-admins so they get a read-only
	// view of their own groups instead of a 403.
	const memberGroups = isAdmin
		? await apiFetch<MemberGroupsRow[]>(`/api/workspaces/${slug}/member-groups`, {
				workspaceSlug: slug,
			})
		: [];
	return { groups, members: ws.members ?? [], memberGroups, projects, role, isAdmin };
}

// ---------------------------------------------------------------------------
// Root data + actions + tab-navigation hooks
// ---------------------------------------------------------------------------

function useGroupManagerData(slug: string) {
	const [data, setData] = useState<Loaded | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);

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

	return { data, loading, error, setError, forbidden, refetch };
}

function useGroupActions(
	slug: string,
	refetch: () => Promise<void>,
	setError: (e: string | null) => void,
	onDeleted: (id: string) => void
) {
	const [newName, setNewName] = useState("");
	const [createErr, setCreateErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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
			onDeleted(id);
			await refetch();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	return { newName, setNewName, createErr, busy, createGroup, deleteGroup };
}

// WAI-ARIA tabs pattern: arrow keys move focus AND activate (automatic
// activation), Home/End jump to the first/last tab.
function nextTabId(tabs: TabId[], activeTab: TabId, key: string): TabId | null {
	const idx = tabs.indexOf(activeTab);
	if (key === "ArrowRight") return tabs[(idx + 1) % tabs.length];
	if (key === "ArrowLeft") return tabs[(idx - 1 + tabs.length) % tabs.length];
	if (key === "Home") return tabs[0];
	if (key === "End") return tabs[tabs.length - 1];
	return null;
}

function useTabRefs() {
	const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
	const focusTab = useCallback((id: TabId) => {
		tabRefs.current[id]?.focus();
	}, []);
	return { tabRefs, focusTab };
}

// ---------------------------------------------------------------------------
// Role indicator — tells the caller what they can do here
// ---------------------------------------------------------------------------

function RoleBanner(props: { role: string; isAdmin: boolean }) {
	return (
		<div class={INFO}>
			<span class={ROLE_TAG}>{props.role}</span>
			<span>
				{props.isAdmin
					? "You manage which groups can access which projects."
					: "Only owners and admins manage groups. Below are the groups that grant you access."}
			</span>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Members overview — group chips + pending badge
// ---------------------------------------------------------------------------

function MemberGroupsCell(props: {
	member: WsMember;
	groups: Array<{ id: string; name: string }>;
}) {
	const isAdmin = props.member.role === "owner" || props.member.role === "admin";
	if (isAdmin) {
		return <span class="text-[0.78rem] text-text-muted">All projects (bypasses groups)</span>;
	}
	if (props.groups.length === 0) return <span class={BADGE_PENDING}>Pending — no access</span>;
	return (
		<>
			{props.groups.map((g) => (
				<span key={g.id} class={CHIP}>
					{g.name}
				</span>
			))}
		</>
	);
}

function MembersMobileCards(props: {
	members: WsMember[];
	groupsByUser: Map<string, Array<{ id: string; name: string }>>;
}) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{props.members.map((m) => (
				<div key={m.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="font-medium text-text-base">{m.name || m.email}</div>
					<div class="text-[0.75rem] text-text-muted mb-1">{m.email}</div>
					<div class="text-[0.75rem] text-text-muted mb-2">Role: {m.role}</div>
					<div>
						<MemberGroupsCell member={m} groups={props.groupsByUser.get(m.id) ?? []} />
					</div>
				</div>
			))}
		</div>
	);
}

function MembersOverview(props: { members: WsMember[]; memberGroups: MemberGroupsRow[] }) {
	const groupsByUser = new Map(props.memberGroups.map((r) => [r.userId, r.groups]));
	return (
		<section class={CARD}>
			<h2 class={H2}>Members</h2>
			<div class="overflow-x-auto max-sm:hidden">
				<table class="w-full border-collapse">
					<thead>
						<tr>
							<th class={TH}>Member</th>
							<th class={TH}>Workspace role</th>
							<th class={TH}>Groups</th>
						</tr>
					</thead>
					<tbody>
						{props.members.map((m) => (
							<tr key={m.id}>
								<td class={TD}>
									<div class="font-medium text-text-base">{m.name || m.email}</div>
									<div class="text-[0.75rem] text-text-muted">{m.email}</div>
								</td>
								<td class={TD}>{m.role}</td>
								<td class={TD}>
									<MemberGroupsCell member={m} groups={groupsByUser.get(m.id) ?? []} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<MembersMobileCards members={props.members} groupsByUser={groupsByUser} />
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
	const [nameDraft, setNameDraft] = useState("");
	const [addUserId, setAddUserId] = useState("");
	const [grantProjectId, setGrantProjectId] = useState("");
	const [grantRole, setGrantRole] = useState<GrantRole>("member");

	const refetch = useCallback(async () => {
		try {
			const d = await apiFetch<GroupDetail>(`/api/workspaces/${slug}/groups/${groupId}`, {
				workspaceSlug: slug,
			});
			setDetail(d);
			setNameDraft(d.name);
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
	const trimmedName = nameDraft.trim();

	return (
		<section class={CARD}>
			<div class="flex items-center gap-2 mb-3">
				<label class="sr-only" for="group-name">
					Group name
				</label>
				<input
					id="group-name"
					class={`${INPUT} flex-1 font-semibold`}
					value={nameDraft}
					disabled={busy}
					onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
				/>
				<button
					type="button"
					class={BTN_PRIMARY}
					disabled={busy || trimmedName === "" || trimmedName === detail.name}
					onClick={() =>
						run(async () => {
							await apiFetch(`/api/workspaces/${slug}/groups/${groupId}`, {
								method: "PATCH",
								workspaceSlug: slug,
								body: { name: trimmedName },
							});
						})
					}
				>
					Rename
				</button>
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
// Groups tab — list + create form + detail editor
// ---------------------------------------------------------------------------

interface GroupsTableProps {
	groups: GroupSummary[];
	isAdmin: boolean;
	busy: boolean;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
}

function GroupsTable({ groups, isAdmin, busy, onSelect, onDelete }: GroupsTableProps) {
	return (
		<div class="overflow-x-auto max-sm:hidden">
			<table class="w-full border-collapse">
				<thead>
					<tr>
						<th class={TH}>Name</th>
						<th class={TH}>Members</th>
						<th class={TH}>Projects</th>
						{isAdmin && <th class={TH} />}
					</tr>
				</thead>
				<tbody>
					{groups.map((g) => (
						<tr key={g.id}>
							<td class={TD}>
								{isAdmin ? (
									<button
										type="button"
										class="text-accent font-medium bg-transparent border-0 cursor-pointer p-0"
										onClick={() => onSelect(g.id)}
									>
										{g.name}
									</button>
								) : (
									<span class="font-medium text-text-base">{g.name}</span>
								)}
							</td>
							<td class={TD}>{g.memberCount}</td>
							<td class={TD}>{g.grantCount}</td>
							{isAdmin && (
								<td class={TD}>
									<button
										type="button"
										class={BTN_DANGER}
										disabled={busy}
										onClick={() => onDelete(g.id)}
									>
										Delete
									</button>
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function GroupsMobileCards({ groups, isAdmin, busy, onSelect, onDelete }: GroupsTableProps) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{groups.map((g) => (
				<div key={g.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="flex justify-between items-center gap-2 mb-1">
						{isAdmin ? (
							<button
								type="button"
								class="text-accent font-medium bg-transparent border-0 cursor-pointer p-0"
								onClick={() => onSelect(g.id)}
							>
								{g.name}
							</button>
						) : (
							<span class="font-medium text-text-base">{g.name}</span>
						)}
						{isAdmin && (
							<button
								type="button"
								class={BTN_DANGER}
								disabled={busy}
								onClick={() => onDelete(g.id)}
							>
								Delete
							</button>
						)}
					</div>
					<div class="text-[0.75rem] text-text-muted">
						{g.memberCount} members · {g.grantCount} projects
					</div>
				</div>
			))}
		</div>
	);
}

interface GroupsSectionProps {
	slug: string;
	isAdmin: boolean;
	data: Loaded;
	newName: string;
	setNewName: (v: string) => void;
	createErr: string | null;
	busy: boolean;
	createGroup: () => void;
	deleteGroup: (id: string) => void;
	selected: string | null;
	setSelected: (id: string | null) => void;
	refetch: () => Promise<void>;
}

function GroupsSection(props: GroupsSectionProps) {
	const { isAdmin, data } = props;
	return (
		<>
			<section class={CARD}>
				<h2 class={H2}>{isAdmin ? "Groups" : "Your groups"}</h2>
				{isAdmin && (
					<div class="flex items-center gap-2 mb-4">
						<input
							class={INPUT}
							placeholder="New group name"
							value={props.newName}
							onInput={(e) => props.setNewName((e.target as HTMLInputElement).value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void props.createGroup();
							}}
						/>
						<button
							type="button"
							class={BTN_PRIMARY}
							disabled={props.busy || !props.newName.trim()}
							onClick={props.createGroup}
						>
							Create group
						</button>
					</div>
				)}
				{props.createErr && (
					<div class="text-[var(--danger-text)] text-[0.8rem] mb-2">{props.createErr}</div>
				)}

				{data.groups.length === 0 ? (
					<div class="text-[0.85rem] text-text-muted">
						{isAdmin
							? "No groups yet."
							: "You don't belong to any groups yet. An owner or admin can add you to one."}
					</div>
				) : (
					<>
						<GroupsTable
							groups={data.groups}
							isAdmin={isAdmin}
							busy={props.busy}
							onSelect={props.setSelected}
							onDelete={props.deleteGroup}
						/>
						<GroupsMobileCards
							groups={data.groups}
							isAdmin={isAdmin}
							busy={props.busy}
							onSelect={props.setSelected}
							onDelete={props.deleteGroup}
						/>
					</>
				)}
			</section>

			{isAdmin && props.selected && (
				<GroupDetailEditor
					slug={props.slug}
					groupId={props.selected}
					members={data.members}
					projects={data.projects}
					onChanged={props.refetch}
					onClose={() => props.setSelected(null)}
				/>
			)}
		</>
	);
}

interface GroupTabsProps {
	tabs: TabId[];
	activeTab: TabId;
	tabRefs: { current: Partial<Record<TabId, HTMLButtonElement | null>> };
	onTabKeyDown: (e: KeyboardEvent) => void;
	onSelect: (id: TabId) => void;
}

function GroupTabs(props: GroupTabsProps) {
	return (
		<div role="tablist" aria-label="Groups" class={TAB_LIST} onKeyDown={props.onTabKeyDown}>
			{props.tabs.map((id) => (
				<button
					key={id}
					ref={(el) => {
						props.tabRefs.current[id] = el;
					}}
					type="button"
					role="tab"
					id={`group-tab-${id}`}
					aria-selected={props.activeTab === id}
					aria-controls={`group-tabpanel-${id}`}
					tabIndex={props.activeTab === id ? 0 : -1}
					class={tabBtnClass(props.activeTab === id)}
					onClick={() => props.onSelect(id)}
				>
					{TAB_LABELS[id]}
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Guard — resolves the loading/forbidden/error/no-workspace states so the
// body below only ever renders once `data` is present.
// ---------------------------------------------------------------------------

interface GuardProps {
	slug: string;
	loading: boolean;
	forbidden: boolean;
	error: string | null;
	data: Loaded | null;
	children: (data: Loaded) => preact.JSX.Element;
}

function GroupManagerGuard({ slug, loading, forbidden, error, data, children }: GuardProps) {
	if (!slug) return <div class={CARD}>No workspace configured.</div>;
	if (loading) return <div class={CARD}>Loading…</div>;
	if (forbidden) return <div class={CARD}>Only workspace owners and admins can manage groups.</div>;
	if (error) return <div class={CARD}>Error: {error}</div>;
	if (!data) return null;
	return children(data);
}

// ---------------------------------------------------------------------------
// Body — tab layout once `data` has loaded.
// ---------------------------------------------------------------------------

interface BodyProps {
	slug: string;
	data: Loaded;
	tab: TabId;
	setTab: (id: TabId) => void;
	tabRefs: { current: Partial<Record<TabId, HTMLButtonElement | null>> };
	focusTab: (id: TabId) => void;
	selected: string | null;
	setSelected: (id: string | null) => void;
	actions: ReturnType<typeof useGroupActions>;
	refetch: () => Promise<void>;
}

function GroupManagerBody(props: BodyProps) {
	const { data, setTab, focusTab } = props;
	const { isAdmin } = data;
	const tabs: TabId[] = isAdmin ? ["members", "groups"] : ["groups"];
	const activeTab: TabId = isAdmin ? props.tab : "groups";

	function onTabKeyDown(e: KeyboardEvent) {
		const nextId = nextTabId(tabs, activeTab, e.key);
		if (!nextId) return;
		e.preventDefault();
		setTab(nextId);
		focusTab(nextId);
	}

	const groupsSection = (
		<GroupsSection
			slug={props.slug}
			isAdmin={isAdmin}
			data={data}
			newName={props.actions.newName}
			setNewName={props.actions.setNewName}
			createErr={props.actions.createErr}
			busy={props.actions.busy}
			createGroup={props.actions.createGroup}
			deleteGroup={props.actions.deleteGroup}
			selected={props.selected}
			setSelected={props.setSelected}
			refetch={props.refetch}
		/>
	);

	return (
		<div>
			<RoleBanner role={data.role} isAdmin={isAdmin} />

			{tabs.length > 1 && (
				<GroupTabs
					tabs={tabs}
					activeTab={activeTab}
					tabRefs={props.tabRefs}
					onTabKeyDown={onTabKeyDown}
					onSelect={setTab}
				/>
			)}

			{isAdmin && activeTab === "members" && (
				<div role="tabpanel" id="group-tabpanel-members" aria-labelledby="group-tab-members">
					<MembersOverview members={data.members} memberGroups={data.memberGroups} />
				</div>
			)}

			{activeTab === "groups" &&
				(isAdmin ? (
					<div role="tabpanel" id="group-tabpanel-groups" aria-labelledby="group-tab-groups">
						{groupsSection}
					</div>
				) : (
					groupsSection
				))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function GroupManager({ workspaceSlug }: Props) {
	const slug = resolveWorkspaceSlug(workspaceSlug);
	const { data, loading, error, setError, forbidden, refetch } = useGroupManagerData(slug);
	const [selected, setSelected] = useState<string | null>(null);
	// Default admins to the Groups tab so the existing create/rename/grant flows
	// (and their tests) stay reachable without an extra click; non-admins always
	// land on Groups anyway since they have no Members tab.
	const [tab, setTab] = useState<TabId>("groups");
	const { tabRefs, focusTab } = useTabRefs();
	const actions = useGroupActions(slug, refetch, setError, (id) => {
		if (selected === id) setSelected(null);
	});

	return (
		<GroupManagerGuard
			slug={slug}
			loading={loading}
			forbidden={forbidden}
			error={error}
			data={data}
		>
			{(loadedData) => (
				<GroupManagerBody
					slug={slug}
					data={loadedData}
					tab={tab}
					setTab={setTab}
					tabRefs={tabRefs}
					focusTab={focusTab}
					selected={selected}
					setSelected={setSelected}
					actions={actions}
					refetch={refetch}
				/>
			)}
		</GroupManagerGuard>
	);
}
