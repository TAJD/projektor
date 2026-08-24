import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { GlossaryHelp } from "./GlossaryHelp";
import type { GlossaryTermId } from "./glossary-definitions";

interface Project {
	id: string;
	key: string;
	name: string;
	slug: string | null;
}

interface Props {
	workspaceSlug?: string;
	pageLabel?: string;
}

// PROJ-395: glossaryId marks tabs whose label is SDLC jargon (Sprints, Epics) for an inline GlossaryHelp toggletip.
const TABS: Array<{ label: string; path: string; glossaryId?: GlossaryTermId }> = [
	{ label: "Overview", path: "/projects/view" },
	{ label: "Issues", path: "/issues" },
	{ label: "Wiki", path: "/wiki" },
	{ label: "Sprints", path: "/sprints" },
	{ label: "Epics", path: "/epics" },
	{ label: "Metrics", path: "/metrics" },
	{ label: "Feedback", path: "/feedback" },
];

const KEY_BADGE_CLASS =
	"font-mono text-[0.72rem] font-medium px-[0.4rem] py-[0.1rem] rounded-[3px] bg-surface border border-border" +
	" text-text-muted";

const TAB_BASE_CLASS =
	"inline-flex items-center shrink-0 whitespace-nowrap px-3 py-2 rounded-t-md text-sm font-medium no-underline" +
	" border border-b-0 -mb-px transition-[color,background] duration-100 max-sm:px-2.5 max-sm:py-1.5" +
	" max-sm:text-[0.8125rem]";

function tabClass(active: boolean): string {
	return `${TAB_BASE_CLASS} ${
		active
			? "text-accent bg-bg border-border font-semibold"
			: "text-text-muted border-transparent hover:text-text-base hover:bg-surface"
	}`;
}

function isTabActive(path: string, activePath: string): boolean {
	if (path === "/projects/view") {
		return activePath === "/projects/view" || activePath.startsWith("/projects/view/");
	}
	return activePath === path;
}

const MORE_TRIGGER_RESERVE_PX = 84;
const TAB_GAP_PX = 2;

function computeVisibleCount(
	containerWidth: number,
	tabWidths: number[],
	moreReserve: number,
	gapPx: number
): number {
	const total =
		tabWidths.reduce((sum, w) => sum + w, 0) + gapPx * Math.max(tabWidths.length - 1, 0);
	if (total <= containerWidth) return tabWidths.length;
	let sum = 0;
	let count = 0;
	for (; count < tabWidths.length; count++) {
		const next = sum + tabWidths[count] + (count > 0 ? gapPx : 0);
		if (next + gapPx + moreReserve > containerWidth) break;
		sum = next;
	}
	return count;
}

function measureContentWidth(el: HTMLElement): number {
	const style = getComputedStyle(el);
	const paddingX =
		Number.parseFloat(style.paddingLeft || "0") + Number.parseFloat(style.paddingRight || "0");
	return Math.max(el.clientWidth - paddingX, 0);
}

export default function ProjectNav({ workspaceSlug, pageLabel }: Props) {
	const [project, setProject] = useState<Project | null>(null);
	const [activePath, setActivePath] = useState("");
	const [tabWidths, setTabWidths] = useState<number[] | null>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const [moreOpen, setMoreOpen] = useState(false);
	const containerRef = useRef<HTMLElement | null>(null);
	const tabRefs = useRef<Array<HTMLElement | null>>([]);
	const moreRootRef = useRef<HTMLDivElement | null>(null);
	const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
	const moreMenuId = useId();

	useEffect(() => {
		setActivePath(window.location.pathname);

		const params = new URLSearchParams(window.location.search);
		// Pretty-URL route (/projects/view/<slug>, see the SPA fallback in apps/api/src/index.ts) has no query param.
		const slugMatch = window.location.pathname.match(/^\/projects\/view\/([^/]+)\/?$/);
		const rawId = params.get("id") || params.get("projectId") || slugMatch?.[1];
		const rawProject = params.get("project");

		const resolve = (p: Project) => {
			setProject(p);
			localStorage.setItem("projektor-last-project-id", p.id);
			if (pageLabel) document.title = `${pageLabel} — ${p.name}`;
		};

		if (rawId) {
			apiFetch<Project>(`/api/projects/${encodeURIComponent(rawId)}`, { workspaceSlug })
				.then((p) => resolve(p))
				.catch(() => {});
		} else if (rawProject) {
			// ?project may be a key (e.g. "PROJ") or UUID; fetch list and find by either
			apiFetch<Project[]>("/api/projects", { workspaceSlug })
				.then((list) => {
					if (Array.isArray(list)) {
						const found = list.find((p) => p.key === rawProject || p.id === rawProject);
						if (found) resolve(found);
					}
				})
				.catch(() => {});
		} else {
			// No project param in URL — recover from localStorage, then fall back to first project
			const storedId = localStorage.getItem("projektor-last-project-id");
			if (storedId) {
				apiFetch<Project>(`/api/projects/${encodeURIComponent(storedId)}`, { workspaceSlug })
					.then((p) => resolve(p))
					.catch(() =>
						// Stored id is stale (or the request failed) — fall back to first project
						apiFetch<Project[]>("/api/projects", { workspaceSlug }).then((list) => {
							if (Array.isArray(list) && list.length > 0) resolve(list[0]);
						})
					)
					.catch(() => {});
			} else {
				apiFetch<Project[]>("/api/projects", { workspaceSlug })
					.then((list) => {
						if (Array.isArray(list) && list.length > 0) resolve(list[0]);
					})
					.catch(() => {});
			}
		}
	}, [workspaceSlug]);

	useLayoutEffect(() => {
		if (!project) return;
		if (tabRefs.current.length !== TABS.length) return;
		// Only measure while every tab is rendered (none collapsed into the "More" menu yet) -
		// collapsed tabs' refs go null, which would otherwise read as 0-width and make
		// computeVisibleCount think everything fits again, re-expanding and re-collapsing forever.
		if (tabRefs.current.some((el) => el == null)) return;
		const widths = tabRefs.current.map((el) => el?.offsetWidth ?? 0);
		if (widths.every((w) => w === 0)) return;
		if (tabWidths && widths.every((w, i) => w === tabWidths[i])) return;
		setTabWidths(widths);
	});

	useEffect(() => {
		if (!project || typeof document === "undefined" || !document.fonts?.ready) return;
		document.fonts.ready.then(() => {
			if (tabRefs.current.length !== TABS.length) return;
			setTabWidths(tabRefs.current.map((el) => el?.offsetWidth ?? 0));
		});
	}, [project]);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		setContainerWidth(measureContentWidth(el));
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (typeof width === "number") setContainerWidth(width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [project]);

	useEffect(() => {
		if (!moreOpen) return;
		function onPointerDown(e: MouseEvent) {
			if (!(e.target instanceof Node) || !moreRootRef.current?.contains(e.target))
				setMoreOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			setMoreOpen(false);
			moreTriggerRef.current?.focus();
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [moreOpen]);

	const visibleCount = useMemo(() => {
		if (!tabWidths || containerWidth <= 0) return TABS.length;
		return computeVisibleCount(containerWidth, tabWidths, MORE_TRIGGER_RESERVE_PX, TAB_GAP_PX);
	}, [tabWidths, containerWidth]);

	if (!project) return null;

	const overviewHref = project.slug
		? `/projects/view/${encodeURIComponent(project.slug)}`
		: `/projects/view?id=${encodeURIComponent(project.id)}`;

	const tabs = TABS.map((t) => {
		let href: string;
		switch (t.path) {
			case "/projects/view":
				href = overviewHref;
				break;
			case "/issues":
				href = `/issues?project=${encodeURIComponent(project.key)}`;
				break;
			default:
				href = `${t.path}?projectId=${encodeURIComponent(project.id)}`;
		}
		return { ...t, href };
	});

	const visibleTabs = tabs.slice(0, visibleCount);
	const overflowTabs = tabs.slice(visibleCount);
	const activeIndex = tabs.findIndex((t) => isTabActive(t.path, activePath));
	const activeInOverflow = activeIndex !== -1 && activeIndex >= visibleCount;

	return (
		<div class="border-b border-border bg-[var(--nav-bg)]">
			<div class="flex items-center gap-2 px-6 pt-3 pb-[0.375rem] max-sm:px-3 max-sm:pt-1.5 max-sm:pb-1">
				<a href={overviewHref} class="no-underline">
					<h2 class="m-0 text-[0.9375rem] max-sm:text-[0.8125rem] font-semibold text-text-base">
						{project.name}
					</h2>
				</a>
				<span class={KEY_BADGE_CLASS}>{project.key}</span>
			</div>
			<nav
				ref={containerRef}
				class="flex flex-nowrap items-center gap-0.5 px-5 max-sm:px-3"
				aria-label="Project sections"
			>
				{visibleTabs.map((tab, i) => {
					const active = isTabActive(tab.path, activePath);
					return (
						<span
							key={tab.path}
							ref={(el) => {
								tabRefs.current[i] = el;
							}}
							class="inline-flex items-center shrink-0"
						>
							<a
								href={tab.href}
								class={tabClass(active)}
								aria-current={active ? "page" : undefined}
							>
								{tab.label}
							</a>
							{tab.glossaryId && <GlossaryHelp id={tab.glossaryId} />}
						</span>
					);
				})}
				{overflowTabs.length > 0 && (
					<div class="relative inline-flex items-center shrink-0" ref={moreRootRef}>
						<button
							type="button"
							ref={moreTriggerRef}
							class={tabClass(activeInOverflow || moreOpen)}
							aria-haspopup="menu"
							aria-expanded={moreOpen}
							aria-controls={moreOpen ? moreMenuId : undefined}
							aria-current={activeInOverflow ? "true" : undefined}
							onClick={() => setMoreOpen((open) => !open)}
						>
							More <span aria-hidden="true">▾</span>
						</button>
						{moreOpen && (
							<div
								id={moreMenuId}
								role="menu"
								aria-label="More project sections"
								class="absolute right-0 top-full z-10 mt-1 flex min-w-[10rem] flex-col rounded-md border border-border bg-bg py-1 shadow-md"
							>
								{overflowTabs.map((tab) => {
									const active = isTabActive(tab.path, activePath);
									return (
										<a
											key={tab.path}
											role="menuitem"
											href={tab.href}
											class="flex min-h-11 items-center gap-1.5 px-3 text-sm font-medium text-text-base no-underline hover:bg-surface"
											aria-current={active ? "page" : undefined}
											onClick={() => setMoreOpen(false)}
										>
											{tab.label}
											{tab.glossaryId && <GlossaryHelp id={tab.glossaryId} />}
										</a>
									);
								})}
							</div>
						)}
					</div>
				)}
			</nav>
		</div>
	);
}
