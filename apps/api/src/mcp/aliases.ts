import type { ArgIssue } from "./validate-args";

type Schema = Record<string, unknown>;

const ISSUE_KEY_SPELLINGS = ["id", "issueId", "ref", "issue", "issue_id"];

const ISSUE_KEY = new Map([
	["get_issue", "id"],
	["update_issue", "id"],
	["delete_issue", "id"],
	["list_comments", "issueId"],
	["add_comment", "issueId"],
	["update_comment", "issueId"],
	["delete_comment", "issueId"],
	["claim_issue", "issueId"],
	["release_issue", "issueId"],
	["list_issue_links", "issueId"],
	["claim_files", "issueId"],
	["release_files", "issueId"],
	["register_agent", "issueId"],
	["start_work", "issue"],
	["finish_work", "issue"],
]);

const SYNONYMS = new Map([
	["description", "body"],
	["content", "body"],
	["text", "body"],
	["message", "body"],
	["files", "paths"],
]);

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function declaredKey(key: string, props: Schema, issueKey: string | undefined): string {
	if (issueKey && ISSUE_KEY_SPELLINGS.includes(key)) return issueKey;
	if (Object.hasOwn(props, key)) return key;
	const synonym = SYNONYMS.get(key);
	if (synonym && Object.hasOwn(props, synonym)) return synonym;
	const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
	return Object.hasOwn(props, camel) ? camel : key;
}

type Walk = { issues: ArgIssue[]; sentPaths: Map<string, string> };

function normalizeObject(
	obj: Record<string, unknown>,
	schema: Schema,
	path: string,
	sentPath: string,
	walk: Walk,
	issueKey?: string
): Record<string, unknown> {
	const props = schema.properties;
	if (!isObject(props)) return obj;
	const prefix = path ? `${path}.` : "";
	const sentPrefix = sentPath ? `${sentPath}.` : "";
	const out: Record<string, unknown> = {};
	const sourceKey = new Map<string, string>();
	for (const [key, raw] of Object.entries(obj)) {
		if (key === "__proto__") continue;
		const target = declaredKey(key, props, issueKey);
		const canonical = `${prefix}${target}`;
		const sent = `${sentPrefix}${key}`;
		const sub = Object.hasOwn(props, target) ? props[target] : undefined;
		const value =
			isObject(raw) && isObject(sub) ? normalizeObject(raw, sub, canonical, sent, walk) : raw;
		const first = sourceKey.get(target);
		if (first === undefined) {
			out[target] = value;
			sourceKey.set(target, key);
			if (sent !== canonical) walk.sentPaths.set(canonical, sent);
		} else if (JSON.stringify(out[target]) !== JSON.stringify(value)) {
			walk.issues.push({
				path: canonical,
				message: `"${first}" and "${key}" are the same argument but have different values; pass only one`,
			});
		}
	}
	return out;
}

function toSentPath(path: string, sentPaths: Map<string, string>): string {
	for (let end = path.length; end > 0; end--) {
		if (end < path.length && path[end] !== "." && path[end] !== "[") continue;
		const sent = sentPaths.get(path.slice(0, end));
		if (sent !== undefined) return sent + path.slice(end);
	}
	return path;
}

export function normalizeToolArgs(
	tool: string,
	inputSchema: Schema,
	args: Record<string, unknown>
): { args: Record<string, unknown>; issues: ArgIssue[]; sentPath: (path: string) => string } {
	const walk: Walk = { issues: [], sentPaths: new Map() };
	const normalized = normalizeObject(args, inputSchema, "", "", walk, ISSUE_KEY.get(tool));
	return {
		args: normalized,
		issues: walk.issues,
		sentPath: (path) => toSentPath(path, walk.sentPaths),
	};
}
