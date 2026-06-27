import { useEffect, useState } from "preact/hooks";
import { buildHeaders } from "../utils/api-client";

interface Project {
	id: string;
	key: string;
	name: string;
}

interface Props {
	workspaceSlug?: string;
}


const TABS = [
	{ label: "Overview", path: "/projects/view" },
	{ label: "Issues", path: "/issues" },
	{ label: "Wiki", path: "/wiki" },
	{ label: "Sprints", path: "/sprints" },
	{ label: "Epics", path: "/epics" },
];

export default function ProjectNav({ workspaceSlug }: Props) {
	const [project, setProject] = useState<Project | null>(null);
	const [activePath, setActivePath] = useState("");

	useEffect(() => {
		setActivePath(window.location.pathname);

		const params = new URLSearchParams(window.location.search);
		const rawId = params.get("id") || params.get("projectId");
		const rawProject = params.get("project");

		if (!rawId && !rawProject) return;

		const headers = buildHeaders(workspaceSlug);

		if (rawId) {
			fetch(`/api/projects/${encodeURIComponent(rawId)}`, { credentials: "include", headers })
				.then((r) => (r.ok ? r.json() : null))
				.then((p) => {
					if (p) setProject(p as Project);
				})
				.catch(() => {});
		} else if (rawProject) {
			// ?project may be a key (e.g. "PROJ") or UUID; fetch list and find by either
			fetch("/api/projects", { credentials: "include", headers: buildHeaders(workspaceSlug) })
				.then((r) => (r.ok ? r.json() : []))
				.then((list: Project[]) => {
					if (Array.isArray(list)) {
						const found = list.find((p) => p.key === rawProject || p.id === rawProject);
						if (found) setProject(found);
					}
				})
				.catch(() => {});
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
			<div class="flex items-center gap-2 px-6 pt-3 pb-[0.375rem]">
				<a
					href={`/projects/view?id=${encodeURIComponent(project.id)}`}
					class="no-underline"
				>
					<h2 class="m-0 text-[0.9375rem] font-semibold text-text-base">{project.name}</h2>
				</a>
				<span class="font-mono text-[0.72rem] font-medium px-[0.4rem] py-[0.1rem] rounded-[3px] bg-surface border border-border text-text-muted">
					{project.key}
				</span>
			</div>
			<nav class="flex gap-0.5 px-5" aria-label="Project sections">
				{tabs.map((tab) => {
					const active = activePath === tab.path;
					return (
						<a
							key={tab.path}
							href={tab.href}
							class={`inline-flex items-center px-3 py-2 rounded-t-md text-sm font-medium no-underline border border-b-0 -mb-px transition-[color,background] duration-100 ${
								active
									? "text-accent bg-bg border-border font-semibold"
									: "text-text-muted border-transparent hover:text-text-base hover:bg-surface"
							}`}
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
