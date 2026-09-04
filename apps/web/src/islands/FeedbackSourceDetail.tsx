import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
	currentProject,
	ensureProjectResolved,
	projectReady,
	projectError as storeProjectError,
} from "../lib/project-context";
import { safeDecodeURIComponent } from "../lib/urls";
import { apiFetch } from "../utils/api-client";
import { persistProjectId } from "../utils/resolve-project-id";
import FeedbackList from "./FeedbackList";
import FeedbackSourceSettings, { type FeedbackSource } from "./FeedbackSourceSettings";
import FeedbackSummary from "./FeedbackSummary";
import Select from "./ui/Select";

interface Props {
	workspaceSlug?: string;
	projectId?: string;
	sourceId?: string;
}

type TabId = "items" | "summary" | "settings";
const TABS: TabId[] = ["items", "summary", "settings"];
const TAB_LABELS: Record<TabId, string> = {
	items: "Items",
	summary: "Summary",
	settings: "Settings",
};

const TAB_LIST = "flex gap-1 border-b border-border mb-4";
const tabBtnClass = (active: boolean) =>
	"px-4 py-2 text-[0.85rem] font-semibold border-b-2 -mb-px bg-transparent cursor-pointer " +
	(active
		? "border-accent text-text-base"
		: "border-transparent text-text-muted hover:text-text-base");

function statusLabel(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "Revoked";
	return s.isActive ? "Active" : "Inactive";
}

function FeedbackSourceHeader({
	source,
	sources,
	projectId,
}: {
	source: FeedbackSource;
	sources: FeedbackSource[];
	projectId: string;
}) {
	return (
		<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
			<div class="flex items-center gap-2">
				<h1 class="text-xl font-bold text-text-base m-0">{source.name}</h1>
				<span class="text-[0.7rem] font-medium px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted">
					{statusLabel(source)}
				</span>
			</div>
			{sources.length > 1 && (
				<Select
					ariaLabel="Switch feedback source"
					value={source.id}
					onChange={(id) => {
						window.location.href = `/feedback/${id}${projectId ? `?projectId=${projectId}` : ""}`;
					}}
					options={sources.map((s) => ({ value: s.id, label: s.name }))}
				/>
			)}
		</div>
	);
}

function FeedbackTabPanels({
	tab,
	workspaceSlug,
	projectId,
	source,
	onSettingsChanged,
}: {
	tab: TabId;
	workspaceSlug?: string;
	projectId: string;
	source: FeedbackSource;
	onSettingsChanged: () => void;
}) {
	return (
		<>
			{tab === "items" && (
				<div role="tabpanel" id="feedback-tabpanel-items" aria-labelledby="feedback-tab-items">
					<FeedbackList workspaceSlug={workspaceSlug} projectId={projectId} sourceId={source.id} />
				</div>
			)}
			{tab === "summary" && (
				<div role="tabpanel" id="feedback-tabpanel-summary" aria-labelledby="feedback-tab-summary">
					<FeedbackSummary
						workspaceSlug={workspaceSlug}
						projectId={projectId}
						sourceId={source.id}
					/>
				</div>
			)}
			{tab === "settings" && (
				<div
					role="tabpanel"
					id="feedback-tabpanel-settings"
					aria-labelledby="feedback-tab-settings"
				>
					<FeedbackSourceSettings
						source={source}
						projectId={projectId}
						workspaceSlug={workspaceSlug}
						onChanged={onSettingsChanged}
					/>
				</div>
			)}
		</>
	);
}

function FeedbackTabBar({
	tab,
	tabRefs,
	onTabKeyDown,
	onTabClick,
}: {
	tab: TabId;
	tabRefs: { current: Partial<Record<TabId, HTMLButtonElement | null>> };
	onTabKeyDown: (e: KeyboardEvent) => void;
	onTabClick: (id: TabId) => void;
}) {
	return (
		<div role="tablist" aria-label="Feedback source" class={TAB_LIST} onKeyDown={onTabKeyDown}>
			{TABS.map((id) => (
				<button
					key={id}
					ref={(el) => {
						tabRefs.current[id] = el;
					}}
					type="button"
					role="tab"
					id={`feedback-tab-${id}`}
					aria-selected={tab === id}
					aria-controls={`feedback-tabpanel-${id}`}
					tabIndex={tab === id ? 0 : -1}
					class={tabBtnClass(tab === id)}
					onClick={() => onTabClick(id)}
				>
					{TAB_LABELS[id]}
				</button>
			))}
		</div>
	);
}

export default function FeedbackSourceDetail({
	workspaceSlug,
	projectId: projectIdProp,
	sourceId: sourceIdProp,
}: Props) {
	useEffect(() => {
		if (!projectIdProp) ensureProjectResolved(workspaceSlug);
	}, [projectIdProp, workspaceSlug]);

	const resolvedReady = projectIdProp !== undefined || projectReady.value;
	const resolvedProjectId = projectIdProp ?? currentProject.value?.id ?? "";
	const resolveError = projectIdProp ? null : storeProjectError.value;

	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (resolvedReady) setProjectId(resolvedProjectId);
	}, [resolvedReady, resolvedProjectId]);

	// Static output can't serve the dynamic /feedback/[sourceId] route directly, so
	// FeedbackSourceDetail is also rendered by the static /feedback/view?sourceId= page (mirrors
	// /issues/view.astro). Named "sourceId", not "id", because this page also renders ProjectNav,
	// which reads ?id= as a *project* id — ?id= here would collide with it.
	// Resolve sourceId from ?sourceId= first, then from the pretty-URL pathname.
	const [sourceId, setSourceId] = useState(sourceIdProp ?? "");
	useEffect(() => {
		if (sourceIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("sourceId");
		if (fromUrl) {
			setSourceId(fromUrl);
			return;
		}
		const m = window.location.pathname.match(/^\/feedback\/([^/]+)/);
		if (m) {
			const decoded = safeDecodeURIComponent(m[1]);
			if (decoded) setSourceId(decoded);
		}
	}, [sourceIdProp]);

	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const error = resolveError ?? fetchError;
	const [tab, setTab] = useState<TabId>("items");
	const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

	const fetchSources = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setFetchError(null);
		try {
			const data = await apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, {
				workspaceSlug,
			});
			const list = Array.isArray(data) ? data : [];
			if (sourceId && !list.some((s) => s.id === sourceId)) {
				// The source may belong to another project in the workspace
				const allProjects = await apiFetch<Array<{ id: string }>>("/api/projects", {
					workspaceSlug,
				});
				if (Array.isArray(allProjects)) {
					for (const p of allProjects) {
						if (p.id === projectId) continue;
						try {
							const otherSources = await apiFetch<FeedbackSource[]>(
								`/api/projects/${p.id}/feedback-sources`,
								{ workspaceSlug }
							);
							if (Array.isArray(otherSources) && otherSources.some((s) => s.id === sourceId)) {
								setProjectId(p.id);
								persistProjectId(p.id);
								setSources(otherSources);
								return;
							}
						} catch {
							// continue search
						}
					}
				}
			}
			setSources(list);
		} catch (e) {
			setFetchError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, sourceId, workspaceSlug]);

	useEffect(() => {
		if (!resolvedReady) return;
		if (!projectId) {
			setLoading(false);
			return;
		}
		fetchSources();
	}, [resolvedReady, projectId, fetchSources]);

	function focusTab(id: TabId) {
		tabRefs.current[id]?.focus();
	}

	function onTabKeyDown(e: KeyboardEvent) {
		const idx = TABS.indexOf(tab);
		let nextId: TabId | null = null;
		if (e.key === "ArrowRight") nextId = TABS[(idx + 1) % TABS.length];
		else if (e.key === "ArrowLeft") nextId = TABS[(idx - 1 + TABS.length) % TABS.length];
		else if (e.key === "Home") nextId = TABS[0];
		else if (e.key === "End") nextId = TABS[TABS.length - 1];
		if (!nextId) return;
		e.preventDefault();
		setTab(nextId);
		focusTab(nextId);
	}

	if (loading) return <p aria-live="polite">Loading source…</p>;
	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	}

	const source = sources.find((s) => s.id === sourceId);
	if (!source) {
		return (
			<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
				Feedback source not found.
			</div>
		);
	}

	return (
		<div>
			<FeedbackSourceHeader source={source} sources={sources} projectId={projectId} />

			<FeedbackTabBar tab={tab} tabRefs={tabRefs} onTabKeyDown={onTabKeyDown} onTabClick={setTab} />

			<FeedbackTabPanels
				tab={tab}
				workspaceSlug={workspaceSlug}
				projectId={projectId}
				source={source}
				onSettingsChanged={fetchSources}
			/>
		</div>
	);
}
