import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import FeedbackList from "./FeedbackList";
import FeedbackSourceSettings, { type FeedbackSource } from "./FeedbackSourceSettings";
import FeedbackSummary from "./FeedbackSummary";
import Select from "./Select";

interface Props {
	workspaceSlug?: string;
	projectId?: string;
	sourceId: string;
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

export default function FeedbackSourceDetail({
	workspaceSlug,
	projectId: projectIdProp,
	sourceId,
}: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);

	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<TabId>("items");
	const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

	const fetchSources = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, {
				workspaceSlug,
			});
			setSources(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, workspaceSlug]);

	useEffect(() => {
		fetchSources();
	}, [fetchSources]);

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
						onClick={() => setTab(id)}
					>
						{TAB_LABELS[id]}
					</button>
				))}
			</div>

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
						onChanged={fetchSources}
					/>
				</div>
			)}
		</div>
	);
}
