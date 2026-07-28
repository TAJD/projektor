import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { renderMd, renderMermaidDiagrams } from "../utils/markdown";

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
		<div style={{ padding: "2rem", textAlign: "center" }}>
			<p style={{ fontSize: "3rem", marginBottom: "1rem" }}>{isExpired ? "🔗" : "⚠"}</p>
			<h2 style={{ marginBottom: "0.5rem" }}>
				{isExpired ? "Link not found or expired" : "Something went wrong"}
			</h2>
			<p style={{ color: "var(--text-muted)" }}>
				{isExpired
					? "This share link may have expired (links are valid for 3 days) or the URL is incorrect."
					: "Unable to load the shared issue. Please try again later."}
			</p>
			<a
				href="/"
				style={{
					color: "var(--accent)",
					textDecoration: "none",
					marginTop: "1.5rem",
					display: "inline-block",
				}}
			>
				← Go to Projektor
			</a>
		</div>
	);
}

function IssueHeader({ issue }: { issue: SharedIssue }) {
	const priorityStyle = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.none;
	return (
		<header style={{ marginBottom: "1.5rem" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "0.5rem",
					marginBottom: "0.75rem",
					flexWrap: "wrap",
				}}
			>
				{/* Priority badge */}
				<span class="badge" style={{ background: priorityStyle.bg, color: priorityStyle.text }}>
					{PRIORITY_LABELS[issue.priority] ?? issue.priority}
				</span>
				{/* Status badge */}
				{issue.status_name && (
					<span
						class="badge"
						style={{
							background: "var(--surface)",
							color: "var(--text-muted)",
							border: "1px solid var(--border)",
						}}
					>
						{issue.status_name}
					</span>
				)}
				{/* Project */}
				{issue.project_name && (
					<span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
						{issue.project_name}
						{issue.project_key ? ` (${issue.project_key})` : ""}
					</span>
				)}
			</div>
			<h1 style={{ margin: 0, fontSize: "1.375rem", fontWeight: 700, lineHeight: 1.3 }}>
				{issue.title}
			</h1>
			<div
				style={{
					marginTop: "0.5rem",
					fontSize: "0.8rem",
					color: "var(--text-muted)",
					display: "flex",
					gap: "1rem",
					flexWrap: "wrap",
				}}
			>
				{issue.assignee_name && <span>Assignee: {issue.assignee_name}</span>}
				<span>Created {formatDate(issue.created_at)}</span>
			</div>
		</header>
	);
}

function CustomFieldsSection({ fields }: { fields: SharedIssue["customFields"] }) {
	if (fields.length === 0) return null;
	return (
		<div style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
			<p
				style={{
					fontSize: "0.7rem",
					fontWeight: 600,
					textTransform: "uppercase",
					letterSpacing: "0.06em",
					color: "var(--text-muted)",
					marginBottom: "0.75rem",
				}}
			>
				Fields
			</p>
			<dl
				style={{
					display: "grid",
					gridTemplateColumns: "max-content 1fr",
					gap: "0.4rem 1rem",
					fontSize: "0.8125rem",
				}}
			>
				{fields.map((f) => (
					<>
						<dt style={{ color: "var(--text-muted)", fontWeight: 500 }}>{f.label}</dt>
						<dd style={{ margin: 0 }}>{f.value}</dd>
					</>
				))}
			</dl>
		</div>
	);
}

// cofferdam-ignore: Design.OrphanExport: imported by pages/share/view.astro — cofferdam doesn't parse .astro imports
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
			<p aria-live="polite" style={{ padding: "2rem" }}>
				Loading…
			</p>
		);

	if (error) return <ErrorState error={error} />;

	if (!issue) return null;

	return (
		<div style={{ padding: "2rem" }}>
			{/* Banner */}
			<div
				style={{
					background: "var(--surface)",
					border: "1px solid var(--border)",
					borderRadius: "6px",
					padding: "0.625rem 1rem",
					marginBottom: "1.5rem",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					flexWrap: "wrap",
					gap: "0.5rem",
					fontSize: "0.8125rem",
					color: "var(--text-muted)",
				}}
			>
				<span>Shared view · Expires {formatDate(issue.expires_at)}</span>
				<a href="/" style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
					Sign in to collaborate →
				</a>
			</div>

			{/* Header */}
			<IssueHeader issue={issue} />

			{/* Body */}
			{issue.body ? (
				<div
					ref={bodyRef}
					class="prose"
					dangerouslySetInnerHTML={{ __html: renderMd(issue.body) }}
					style={{ marginBottom: "1.5rem" }}
				/>
			) : (
				<p style={{ color: "var(--text-muted)", fontStyle: "italic", marginBottom: "1.5rem" }}>
					No description.
				</p>
			)}

			{/* Custom fields */}
			<CustomFieldsSection fields={issue.customFields} />
			<style>{MERMAID_PROSE_STYLES}</style>
		</div>
	);
}
