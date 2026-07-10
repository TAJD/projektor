import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface Project {
	id: string;
	key: string;
	name: string;
}

interface Props {
	workspaceSlug?: string;
	pageLabel?: string;
}

const TABS = [
	{ label: "Overview", path: "/projects/view" },
	{ label: "Issues", path: "/issues" },
	{ label: "Wiki", path: "/wiki" },
	{ label: "Sprints", path: "/sprints" },
	{ label: "Epics", path: "/epics" },
	{ label: "Metrics", path: "/metrics" },
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

export default function ProjectNav({ workspaceSlug, pageLabel }: Props) {
	const [project, setProject] = useState<Project | null>(null);
	const [activePath, setActivePath] = useState("");

	useEffect(() => {
		setActivePath(window.location.pathname);

		const params = new URLSearchParams(window.location.search);
		const rawId = params.get("id") || params.get("projectId");
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

	if (!project) return null;

	const tabs = TABS.map((t) => {
		let href: string;
		switch (t.path) {
			case "/projects/view":
				href = `/projects/view?id=${encodeURIComponent(project.id)}`;
				break;
			case "/issues":
				href = `/issues?project=${encodeURIComponent(project.key)}`;
				break;
			default:
				href = `${t.path}?projectId=${encodeURIComponent(project.id)}`;
		}
		return { ...t, href };
	});

	return (
		<div class="border-b border-border bg-[var(--nav-bg)]">
			<div class="flex items-center gap-2 px-6 pt-3 pb-[0.375rem] max-sm:px-3 max-sm:pt-1.5 max-sm:pb-1">
				<a href={`/projects/view?id=${encodeURIComponent(project.id)}`} class="no-underline">
					<h2 class="m-0 text-[0.9375rem] max-sm:text-[0.8125rem] font-semibold text-text-base">
						{project.name}
					</h2>
				</a>
				<span class={KEY_BADGE_CLASS}>{project.key}</span>
			</div>
			<nav
				class="flex gap-0.5 px-5 max-sm:px-3 max-sm:overflow-x-auto"
				aria-label="Project sections"
			>
				{tabs.map((tab) => {
					const active = activePath === tab.path;
					return (
						<a
							key={tab.path}
							href={tab.href}
							class={tabClass(active)}
							aria-current={active ? "page" : undefined}
						>
							{tab.label}
						</a>
					);
				})}
			</nav>
		</div>
	);
}
