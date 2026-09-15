import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { applyShareBrand, type WorkspaceBrandDto } from "../utils/brand";
import { renderMd, renderMermaidDiagrams } from "../utils/markdown";
import { Badge } from "./ui/Badge";

interface SharedIssue {
	title: string;
	body: string | null;
	priority: string;
	status_name: string | null;
	status_category: string | null;
	project_key: string | null;
	project_name: string | null;
	assignee_name: string | null;
	created_at: number;
	expires_at: number;
	customFields: Array<{ key: string; label: string; type: string; value: string }>;
	brand: WorkspaceBrandDto;
}

const PRIORITY_LABELS: Record<string, string> = {
	urgent: "Urgent",
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "No priority",
};

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "var(--priority-urgent-bg)", text: "var(--priority-urgent-text)" },
	high: { bg: "var(--priority-high-bg)", text: "var(--priority-high-text)" },
	medium: { bg: "var(--priority-medium-bg)", text: "var(--priority-medium-text)" },
	low: { bg: "var(--priority-low-bg)", text: "var(--priority-low-text)" },
	none: { bg: "var(--priority-none-bg)", text: "var(--priority-none-text)" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Minimal duplicate of the mermaid rules in WikiPage.tsx's WIKI_PAGE_STYLES
// (~line 1749) — the share page's .prose is hand-rolled CSS in
// pages/share/view.astro, not WikiPage's, so there's no shared stylesheet to hang this on.
const MERMAID_PROSE_STYLES = `
	.prose pre.mermaid {
		display: flex;
		justify-content: center;
		background: none;
		padding: 0;
	}
	.prose pre.mermaid svg {
		max-width: 100%;
		width: auto;
		height: auto;
	}
`;

function formatDate(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function ErrorState({ error }: { error: string }) {
	const isExpired = error === "not_found";
	return (
		<div class="p-8 text-center">
			<p class="text-5xl mb-4">{isExpired ? "🔗" : "⚠"}</p>
			<h2 class="mb-2">{isExpired ? "Link not found or expired" : "Something went wrong"}</h2>
			<p class="text-text-muted">
				{isExpired
					? "This share link may have expired (links are valid for 3 days) or the URL is incorrect."
					: "Unable to load the shared issue. Please try again later."}
			</p>
			<a href="/" class="text-accent no-underline mt-6 inline-block">
				← Go to Projektor
			</a>
		</div>
	);
}

function IssueHeader({ issue }: { issue: SharedIssue }) {
	const priorityStyle = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.none;
	return (
		<header class="mb-6">
			<div class="flex items-center gap-2 mb-3 flex-wrap">
				{/* Priority badge */}
				<Badge style={{ background: priorityStyle.bg, color: priorityStyle.text }}>
					{PRIORITY_LABELS[issue.priority] ?? issue.priority}
				</Badge>
				{/* Status badge */}
				{issue.status_name && (
					<Badge class="bg-surface text-text-muted border border-border">{issue.status_name}</Badge>
				)}
				{/* Project */}
				{issue.project_name && (
					<span class="text-xs text-text-muted">
						{issue.project_name}
						{issue.project_key ? ` (${issue.project_key})` : ""}
					</span>
				)}
			</div>
			<h1 class="m-0 text-[1.375rem] font-bold leading-[1.3]">{issue.title}</h1>
			<div class="mt-2 text-[0.8rem] text-text-muted flex gap-4 flex-wrap">
				{issue.assignee_name && <span>Assignee: {issue.assignee_name}</span>}
				<span>Created {formatDate(issue.created_at)}</span>
			</div>
		</header>
	);
}

function CustomFieldsSection({ fields }: { fields: SharedIssue["customFields"] }) {
	if (fields.length === 0) return null;
	return (
		<div class="border-t border-border pt-4">
			<p class="text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-muted mb-3">
				Fields
			</p>
			<dl class="grid grid-cols-[max-content_1fr] gap-[0.4rem_1rem] text-[0.8125rem]">
				{fields.map((f) => (
					<>
						<dt class="text-text-muted font-medium">{f.label}</dt>
						<dd class="m-0">{f.value}</dd>
					</>
				))}
			</dl>
		</div>
	);
}

export default function ShareView() {
	const [issue, setIssue] = useState<SharedIssue | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	// Hydrate ```mermaid code blocks into rendered diagrams (mirrors WikiPage's effect).
	useEffect(() => {
		const container = bodyRef.current;
		if (!container) return;
		renderMermaidDiagrams(container).catch(() => {
			// non-fatal — leave the raw code block visible
		});
	}, [issue?.body]);

	useEffect(() => {
		const m = window.location.pathname.match(/^\/share\/([^/]+)$/);
		if (!m) {
			setError("Invalid share link.");
			setLoading(false);
			return;
		}
		const token = m[1];
		// Public/unauthenticated endpoint - apiFetch's credentials: "include" and
		// missing workspace header are both no-ops here since /api/share is open.
		apiFetch<SharedIssue>(`/api/share/${token}`)
			.then((data) => {
				applyShareBrand(data.brand);
				setIssue(data);
				setLoading(false);
			})
			.catch((e) => {
				setError(String(e.message?.includes("404") ? "not_found" : "error"));
				setLoading(false);
			});
	}, []);

	if (loading)
		return (
			<p aria-live="polite" class="p-8">
				Loading…
			</p>
		);

	if (error) return <ErrorState error={error} />;

	if (!issue) return null;

	return (
		<div class="p-8">
			{/* Banner */}
			<div class="bg-surface border border-border rounded-md py-[0.625rem] px-4 mb-6 flex items-center justify-between flex-wrap gap-2 text-[0.8125rem] text-text-muted">
				<span>Shared view · Expires {formatDate(issue.expires_at)}</span>
				<a href="/" class="text-accent no-underline font-medium">
					Sign in to collaborate →
				</a>
			</div>

			{/* Header */}
			<IssueHeader issue={issue} />

			{/* Body */}
			{issue.body ? (
				<div
					ref={bodyRef}
					class="prose mb-6"
					dangerouslySetInnerHTML={{ __html: renderMd(issue.body) }}
				/>
			) : (
				<p class="text-text-muted italic mb-6">No description.</p>
			)}

			{/* Custom fields */}
			<CustomFieldsSection fields={issue.customFields} />
			<style>{MERMAID_PROSE_STYLES}</style>
		</div>
	);
}
