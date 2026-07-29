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
