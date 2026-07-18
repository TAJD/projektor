export interface TaskStatus {
	id: string;
	key: string;
	name: string;
	category: string;
	color: string | null;
}

export interface CustomFieldValue {
	key: string;
	label: string;
	type: string;
	value: string;
}

export interface IssueLink {
	id: string;
	type: "blocks" | "blocked_by" | "relates_to" | "duplicates";
	linkedIssueId: string;
	linkedIssueTitle: string;
	linkedIssueNumber: number;
	linkedIssueProjectKey: string;
	linkedIssueStatusCategory: string;
	createdById: string;
	createdAt: number;
}

export interface Attachment {
	id: string;
	kind: "file" | "wiki_ref" | "url";
	filename: string;
	contentType: string;
	size: number;
	url: string | null;
	createdAt: number;
	wikiPage: { id: string; title: string; url: string } | null;
}

export interface IssueData {
	id: string;
	number: number;
	title: string;
	body: string | null;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	parent_id: string | null;
	project_key: string | null;
	project_name: string | null;
	type_key: string | null;
	type_name: string | null;
	status_id: string | null;
	status_key: string | null;
	status_name: string | null;
	status_category: string | null;
	created_at: number;
	updated_at: number;
	customFields: CustomFieldValue[];
	rollup?: { total: number; done: number; remaining: number; byStatus: Record<string, number> };
}

export interface Comment {
	id: string;
	body: string;
	author_id: string;
	author_name: string;
	author_email: string;
	created_at: number;
}

export interface Member {
	id: string;
	name: string | null;
	email: string;
}

export const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "var(--priority-urgent-bg)", text: "var(--priority-urgent-text)" },
	high: { bg: "var(--priority-high-bg)", text: "var(--priority-high-text)" },
	medium: { bg: "var(--priority-medium-bg)", text: "var(--priority-medium-text)" },
	low: { bg: "var(--priority-low-bg)", text: "var(--priority-low-text)" },
	none: { bg: "var(--priority-none-bg)", text: "var(--priority-none-text)" },
};

export const LINK_TYPE_LABELS: Record<string, string> = {
	blocks: "Blocks",
	blocked_by: "Blocked by",
	relates_to: "Relates to",
	duplicates: "Duplicates",
};

export const LINK_TYPE_OPTIONS = [
	{ value: "relates_to", label: "Relates to" },
	{ value: "blocks", label: "Blocks" },
	{ value: "blocked_by", label: "Blocked by" },
	{ value: "duplicates", label: "Duplicates" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function relativeTime(unixSeconds: number): string {
	const diff = Date.now() / 1000 - unixSeconds;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
	return formatDate(unixSeconds);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
