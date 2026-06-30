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
export const TaxonomyIdSchema = z.union([
	z.string().uuid(),
	z.string().regex(/^[0-9a-f]{32}$/i, "Invalid id"),
]);
