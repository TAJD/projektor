import { z } from "zod";

export const RoleEnum = z.enum(["owner", "admin", "member", "viewer"]);

export const StatusEnum = z.enum([
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
]);
export const PriorityEnum = z.enum(["urgent", "high", "medium", "low", "none"]);

// Identifier guard for single-id mutations (deletes, complete) whose handlers
// otherwise only cast/typeof-check the id. Co-locates a Zod check with the write
// so no caller can reach the DB with an empty/non-string id. (PROJ-205)
export const IdSchema = z.string().min(1, "id is required");

// A display ref such as "PROJ-42". Digits are bounded: parseInt("9".repeat(400)) is Infinity,
// which drizzle would happily bind and D1 would reject as a type error — a 500 where a 404
// belongs. Anything longer than this isn't a ref, so it falls through to being treated as an
// id and 404s. Lives here (not in services/) so schemas can accept refs without importing
// from the service layer; services/issue-ref.ts re-exports it.
export const ISSUE_REF_PATTERN = /^([A-Z][A-Z0-9]*)-(\d{1,9})$/;

// PROJ-959: every MCP/REST input that names an issue accepts either the UUID or a ref like
// "PROJ-42". The schema only checks the *shape*; the service resolves a ref to its UUID
// (services/issue-ref.ts) before doing anything else, so downstream code only ever sees UUIDs.
export const IssueIdOrRefSchema = z
	.string()
	.refine((v) => z.string().uuid().safeParse(v).success || ISSUE_REF_PATTERN.test(v), {
		message: 'must be an issue UUID or a ref like "PROJ-42"',
	});

// Task-type and task-status IDs come in two shapes: runtime-created ones use
// crypto.randomUUID() (dashed UUID), while seeded defaults use 32-char hex
// hashes (e.g. "ea3df70345804c3d26ebf139816cae8f"). Accept both so the seeded
// Epic type / default statuses can actually be assigned to issues. See PROJ-69.
//
// PROJ-72 decision: keep the dual format (this schema) rather than migrating
// seeded rows to real UUIDs. Normalizing would require rewriting seeded IDs
// and every FK referencing them (issues.type_id/status_id) for a cosmetic
// win; codifying the convention is cheap and the audited call sites
// (issues.ts typeId/statusId) already use it correctly. Any *single-id*
// field that can hold a task-type or task-status ID must use
// TaxonomyIdSchema, never `.uuid()` directly. Deliberate exceptions:
// comma-separated filter params (issues.ts statusIds/excludeTypeIds) stay
// plain z.string() since they're split and passed straight to inArray() /
// notInArray(), not validated as a single id shape.
export const TaxonomyIdSchema = z.union([
	z.string().uuid(),
	z.string().regex(/^[0-9a-f]{32}$/i, "Invalid id"),
]);

// Query-string booleans arrive as strings; MCP sends real JSON booleans. z.coerce.boolean()
// makes the string "false" truthy (any non-empty string coerces to true), silently inverting
// params like needsAudit=false. Parse the string forms explicitly instead. "" (bare ?flag with
// no value) maps to false, matching Boolean("") under the old z.coerce.boolean() behavior.
export const BooleanQueryParam = z.union([
	z.boolean(),
	z.enum(["true", "1"]).transform(() => true),
	z.enum(["false", "0", ""]).transform(() => false),
]);
