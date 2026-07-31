import { parse as parseYaml } from "yaml";
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
};

export const EMPTY_WIKI_FRONTMATTER: WikiFrontmatterMeta = {
	type: null,
	tags: [],
	status: null,
	verifiedAt: null,
	verifiedBy: null,
	owners: [],
	verifyInterval: null,
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

// PROJ-488: parses+validates the optional frontmatter block out of a wiki page's raw
// `content`. `content` itself is left untouched — frontmatter is denormalized into
// columns purely for filtering; the canonical markdown (frontmatter included) keeps
// round-tripping through create/update/revisions/diff exactly as before this feature.
// Invalid YAML or a frontmatter value that fails schema validation throws a
// ValidationError — this is intentionally never silently ignored or coerced.
export function parseWikiFrontmatter(content: string): WikiFrontmatterMeta {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return EMPTY_WIKI_FRONTMATTER;

	let raw: unknown;
	try {
		raw = parseYaml(match[1]);
	} catch (e) {
		throw new ValidationError({
			formErrors: [`Invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`],
			fieldErrors: {},
		});
	}

	// An empty `---\n---\n` block parses to null/undefined — treat as "no frontmatter"
	// rather than an error, since it's an easy no-op state to end up in when editing.
	if (raw === null || raw === undefined) return EMPTY_WIKI_FRONTMATTER;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ValidationError({
			formErrors: ["Frontmatter must be a YAML mapping (key: value pairs), not a list or scalar"],
			fieldErrors: {},
		});
	}

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

	const parsed = WikiFrontmatterSchema.safeParse(normalized);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const d = parsed.data;
	return {
		type: d.type ?? null,
		tags: d.tags ?? [],
		status: d.status ?? null,
		verifiedAt: d.verified_at ?? null,
		verifiedBy: d.verified_by ?? null,
		owners: d.owners ?? [],
		verifyInterval: d.verify_interval ?? null,
	};
}
