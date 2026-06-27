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

// Task-type and task-status IDs come in two shapes: runtime-created ones use
// crypto.randomUUID() (dashed UUID), while seeded defaults use 32-char hex
// hashes (e.g. "ea3df70345804c3d26ebf139816cae8f"). Accept both so the seeded
// Epic type / default statuses can actually be assigned to issues. See PROJ-69.
export const TaxonomyIdSchema = z.union([
	z.string().uuid(),
	z.string().regex(/^[0-9a-f]{32}$/i, "Invalid id"),
]);
