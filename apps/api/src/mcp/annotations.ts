import type { MCPToolAnnotations } from "@projektor/types";

/**
 * Shared MCP tool annotation constants/helpers (PROJ-887), so the 119 tools in
 * apps/api/src/mcp/*.ts don't each hand-write the same literal shape.
 *
 * `openWorldHint: false` on every tool: every core tool only ever talks to this
 * workspace's own D1/KV/R2 data, never an external ("open world") system.
 *
 * The 22-tool destructive set (DESTRUCTIVE_TOOLS below) mirrors the destructive
 * tier from the wiki page mcp-context-auth-design-2026-09-23 and the fallback
 * rule from the ticket: delete_*, remove_*, purge_wiki_trash, rotate_* or revoke_*,
 * update_member_role, discard_wiki_draft, release_*.
 */

/** Annotations for a read-only tool (list_/get_/search_/wiki_tree). */
export const READ: MCPToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/**
 * Annotations for a non-read (mutating) tool.
 * - `destructive`: true for the 22-tool destructive set, false otherwise.
 * - `idempotent`: pass only where obviously true (update_*, set_* or claim_*-by-id) or
 *   obviously false (create_*); omit for tools where it is not clear-cut (e.g. patch_*).
 */
export function WRITE(opts: { destructive: boolean; idempotent?: boolean }): MCPToolAnnotations {
	return {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: opts.destructive,
		...(opts.idempotent !== undefined ? { idempotentHint: opts.idempotent } : {}),
	};
}

/** Non-destructive, non-idempotent write (e.g. create_*). */
export const CREATE: MCPToolAnnotations = WRITE({ destructive: false, idempotent: false });

/** Non-destructive, idempotent write (e.g. update_*, set_* or claim_*-by-id). */
export const IDEMPOTENT_WRITE: MCPToolAnnotations = WRITE({ destructive: false, idempotent: true });

/** Non-destructive write with no clear-cut idempotency. */
export const PLAIN_WRITE: MCPToolAnnotations = WRITE({ destructive: false });

/** Destructive write; idempotentHint is left unset (spec default: false). */
export const DESTRUCTIVE: MCPToolAnnotations = WRITE({ destructive: true });

/**
 * The 22 destructive tools (PROJ-887 AC). Kept here as the single source of
 * truth so the annotations test can assert every tool's `destructiveHint`
 * against this exact set.
 */
export const DESTRUCTIVE_TOOLS: readonly string[] = [
	// delete_*
	"delete_comment",
	"delete_custom_field_def",
	"delete_attachment",
	"delete_group",
	"delete_issue",
	"delete_issue_link",
	"delete_project",
	"delete_sprint",
	"delete_task_status",
	"delete_task_type",
	"delete_wiki_page",
	"delete_workspace",
	// remove_*
	"remove_group_member",
	"remove_group_grant",
	"remove_member",
	// purge_wiki_trash
	"purge_wiki_trash",
	// rotate_* or revoke_*
	"rotate_feedback_source_token",
	"revoke_feedback_source",
	// update_member_role
	"update_member_role",
	// discard_wiki_draft
	"discard_wiki_draft",
	// release_*
	"release_files",
	"release_issue",
];
