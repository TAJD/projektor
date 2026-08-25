import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WikiFrontmatterSchema } from "../schemas/wiki";
import { ValidationError } from "./errors";

// PROJ-488 (R6): matches a leading `---\n<yaml>\n---\n` block, the standard frontmatter
// convention. CRLF-tolerant since pages can be edited from any client. A page with no
// leading `---` line has no frontmatter at all (not an error — frontmatter is optional).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type WikiFrontmatterMeta = {
	type: string | null;
	tags: string[];
	status: string | null;
	verifiedAt: number | null;
	verifiedBy: string | null;
	owners: string[];
	verifyInterval: number | null;
	isTemplate: boolean;
};

const EMPTY_WIKI_FRONTMATTER: WikiFrontmatterMeta = {
	type: null,
	tags: [],
	status: null,
	verifiedAt: null,
	verifiedBy: null,
	owners: [],
	verifyInterval: null,
	isTemplate: false,
};

// YAML 1.1 (what the `yaml` package parses by default) auto-converts an unquoted
// `verified_at: 2026-01-01`-shaped scalar into a JS Date — Zod's z.number() would reject
// that outright, so normalize before validation. A plain number is treated as an
// already-unix-seconds value (matching this repo's timestamp convention); a string is
// parsed as an ISO date. Throws a plain Error (caller wraps it as a ValidationError) on
// anything else, or an unparseable string.
function normalizeVerifiedAt(value: unknown): number | null {
	if (value === null) return null;
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (typeof value === "number") return Math.floor(value);
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) {
			throw new Error(`verified_at is not a valid date: '${value}'`);
		}
		return Math.floor(parsed.getTime() / 1000);
	}
	throw new Error("verified_at must be a date or a unix-seconds number");
}

function parseFrontmatterYaml(yamlBlock: string): unknown {
	try {
		return parseYaml(yamlBlock);
	} catch {
		// Never interpolate the third-party YAML parser's own exception message —
		// it can describe internal parser state, not just the caller's input.
		throw new ValidationError({
			formErrors: ["Invalid YAML frontmatter"],
			fieldErrors: {},
		});
	}
}

function normalizeFrontmatterRecord(raw: object): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	if ("verified_at" in normalized) {
		try {
			normalized.verified_at = normalizeVerifiedAt(normalized.verified_at);
		} catch (e) {
			throw new ValidationError({
				formErrors: [e instanceof Error ? e.message : String(e)],
				fieldErrors: {},
			});
		}
	}
	return normalized;
}

// PROJ-488: parses+validates the optional frontmatter block out of a wiki page's raw
// `content`. `content` itself is left untouched — frontmatter is denormalized into
// columns purely for filtering; the canonical markdown (frontmatter included) keeps
// round-tripping through create/update/revisions/diff exactly as before this feature.
// Invalid YAML or a frontmatter value that fails schema validation throws a
// ValidationError — this is intentionally never silently ignored or coerced.
// An empty `---\n---\n` block parses to null/undefined — treat as "no frontmatter"
// rather than an error, since it's an easy no-op state to end up in when editing.
// Anything else that isn't a plain mapping (a list, a scalar) is a genuine error.
function requireFrontmatterMapping(raw: unknown): Record<string, unknown> | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ValidationError({
			formErrors: ["Frontmatter must be a YAML mapping (key: value pairs), not a list or scalar"],
			fieldErrors: {},
		});
	}
	return raw as Record<string, unknown>;
}

function toFrontmatterMeta(d: ReturnType<typeof WikiFrontmatterSchema.parse>): WikiFrontmatterMeta {
	return {
		type: d.type ?? null,
		tags: d.tags ?? [],
		status: d.status ?? null,
		verifiedAt: d.verified_at ?? null,
		verifiedBy: d.verified_by ?? null,
		owners: d.owners ?? [],
		verifyInterval: d.verify_interval ?? null,
		isTemplate: d.template ?? false,
	};
}

export function parseWikiFrontmatter(content: string): WikiFrontmatterMeta {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return EMPTY_WIKI_FRONTMATTER;

	const raw = requireFrontmatterMapping(parseFrontmatterYaml(match[1]));
	if (raw === null) return EMPTY_WIKI_FRONTMATTER;

	const normalized = normalizeFrontmatterRecord(raw);
	const parsed = WikiFrontmatterSchema.safeParse(normalized);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	return toFrontmatterMeta(parsed.data);
}

// PROJ-491 (R9): strips the `template: true` frontmatter key when seeding a new page's
// content from a template page — a page created FROM a template is not itself a template
// unless the author explicitly adds the flag back. Every other frontmatter key (type,
// tags, status, ...) carries over untouched. If stripping leaves no frontmatter keys at
// all, the block is dropped entirely rather than left as an empty `---\n---\n` shell.
export function stripTemplateFlag(content: string): string {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return content;
	const rest = content.slice(match[0].length);

	const raw = parseYaml(match[1]);
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return content;
	}
	const { template: _template, ...remaining } = raw as Record<string, unknown>;
	if (Object.keys(remaining).length === 0) return rest;

	const yamlText = stringifyYaml(remaining).trimEnd();
	return `---\n${yamlText}\n---\n${rest}`;
}

export function setWikiFrontmatterFields(content: string, values: Record<string, unknown>): string {
	const match = FRONTMATTER_RE.exec(content);
	const rest = match ? content.slice(match[0].length) : content;

	let raw: Record<string, unknown> = {};
	if (match) {
		const parsedRaw = parseYaml(match[1]);
		if (parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)) {
			raw = { ...(parsedRaw as Record<string, unknown>) };
		}
	}

	for (const [key, value] of Object.entries(values)) {
		if (value === null) delete raw[key];
		else raw[key] = value;
	}

	if (Object.keys(raw).length === 0) return rest;

	const yamlText = stringifyYaml(raw).trimEnd();
	return `---\n${yamlText}\n---\n${rest}`;
}

export function stampWikiFrontmatterVerification(
	content: string,
	verifiedAtSeconds: number,
	verifiedBy: string
): string {
	const match = FRONTMATTER_RE.exec(content);
	const rest = match ? content.slice(match[0].length) : content;

	let raw: Record<string, unknown> = {};
	if (match) {
		const parsedRaw = parseYaml(match[1]);
		if (parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)) {
			raw = { ...(parsedRaw as Record<string, unknown>) };
		}
	}
	raw.verified_at = new Date(verifiedAtSeconds * 1000).toISOString();
	raw.verified_by = verifiedBy;

	const yamlText = stringifyYaml(raw).trimEnd();
	return `---\n${yamlText}\n---\n${rest}`;
}
