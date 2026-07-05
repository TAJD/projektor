import { z } from "zod";
import { NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const ListProjectActivitySchema = z.object({
	projectId: z.string().uuid(),
	since: z.number().int().optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export interface ActivityEvent {
	type: string;
	actor: string | null;
	entity_type: string;
	entity_id: string;
	entity_ref: string;
	summary: string;
	created_at: number;
}

async function fetchActivityRows(
	ctx: ServiceCtx,
	projectId: string,
	since: number | undefined,
	limit: number
): Promise<ActivityEvent[]> {
	// D1 limits compound SELECT to a small number of terms, so we run separate
	// queries per event category and merge/sort in JS.
	const sinceFilter = (col: string) => (since !== undefined ? `AND ${col} >= ?` : "");
	const s = since !== undefined ? [since] : [];

	const [issues, comments, statusChanges, wikiPages, sprints] = await Promise.all([
		// issue_created
		ctx.db
			.prepare(
				`SELECT 'issue_created' AS type, i.created_by_id AS actor,
				        'issue' AS entity_type, i.id AS entity_id,
				        p.key || '-' || CAST(i.number AS TEXT) AS entity_ref,
				        i.title AS summary, i.created_at
				 FROM issues i JOIN projects p ON i.project_id = p.id
				 WHERE i.project_id = ? AND i.workspace_id = ? ${sinceFilter("i.created_at")}
				 ORDER BY i.created_at DESC LIMIT ?`
			)
			.bind(projectId, ctx.workspaceId, ...s, limit)
			.all<ActivityEvent>(),

		// issue_commented
		ctx.db
			.prepare(
				`SELECT 'issue_commented' AS type, ic.author_id AS actor,
				        'issue' AS entity_type, i.id AS entity_id,
				        p.key || '-' || CAST(i.number AS TEXT) AS entity_ref,
				        'Comment on: ' || i.title AS summary, ic.created_at
				 FROM issue_comments ic
				 JOIN issues i ON ic.issue_id = i.id
				 JOIN projects p ON i.project_id = p.id
				 WHERE i.project_id = ? AND i.workspace_id = ? ${sinceFilter("ic.created_at")}
				 ORDER BY ic.created_at DESC LIMIT ?`
			)
			.bind(projectId, ctx.workspaceId, ...s, limit)
			.all<ActivityEvent>(),

		// issue_status_changed (via activity log)
		ctx.db
			.prepare(
				`SELECT 'issue_status_changed' AS type, a.actor_id AS actor,
				        'issue' AS entity_type, i.id AS entity_id,
				        p.key || '-' || CAST(i.number AS TEXT) AS entity_ref,
				        'Status changed: ' || i.title AS summary, a.created_at
				 FROM activity a
				 JOIN issues i ON a.entity_id = i.id
				 JOIN projects p ON i.project_id = p.id
				 WHERE a.entity_type = 'issue' AND a.action = 'updated'
				   AND a.workspace_id = ? AND i.project_id = ?
				   AND json_extract(a.diff, '$.status') IS NOT NULL
				   ${sinceFilter("a.created_at")}
				 ORDER BY a.created_at DESC LIMIT ?`
			)
			.bind(ctx.workspaceId, projectId, ...s, limit)
			.all<ActivityEvent>(),

		// wiki_page_created + wiki_page_edited (2-term UNION, well under D1 limit)
		ctx.db
			.prepare(
				`SELECT 'wiki_page_created' AS type, wp.created_by_id AS actor,
				        'wiki_page' AS entity_type, wp.id AS entity_id,
				        wp.slug AS entity_ref, wp.title AS summary, wp.created_at
				 FROM wiki_pages wp
				 WHERE wp.project_id = ? AND wp.workspace_id = ? ${sinceFilter("wp.created_at")}
				 UNION ALL
				 SELECT 'wiki_page_edited' AS type, wp.updated_by_id AS actor,
				        'wiki_page' AS entity_type, wp.id AS entity_id,
				        wp.slug AS entity_ref, wp.title AS summary, wp.updated_at AS created_at
				 FROM wiki_pages wp
				 WHERE wp.project_id = ? AND wp.workspace_id = ?
				   AND wp.updated_at != wp.created_at ${sinceFilter("wp.updated_at")}
				 ORDER BY created_at DESC LIMIT ?`
			)
			.bind(projectId, ctx.workspaceId, ...s, projectId, ctx.workspaceId, ...s, limit)
			.all<ActivityEvent>(),

		// sprint_started + sprint_completed (2-term UNION)
		ctx.db
			.prepare(
				`SELECT 'sprint_started' AS type, NULL AS actor,
				        'sprint' AS entity_type, s.id AS entity_id,
				        s.name AS entity_ref, 'Sprint started: ' || s.name AS summary,
				        s.start_date AS created_at
				 FROM sprints s
				 WHERE s.project_id = ? AND s.workspace_id = ?
				   AND s.status IN ('active', 'completed') AND s.start_date IS NOT NULL
				   ${sinceFilter("s.start_date")}
				 UNION ALL
				 SELECT 'sprint_completed' AS type, NULL AS actor,
				        'sprint' AS entity_type, s.id AS entity_id,
				        s.name AS entity_ref, 'Sprint completed: ' || s.name AS summary,
				        s.updated_at AS created_at
				 FROM sprints s
				 WHERE s.project_id = ? AND s.workspace_id = ? AND s.status = 'completed'
				   ${sinceFilter("s.updated_at")}
				 ORDER BY created_at DESC LIMIT ?`
			)
			.bind(projectId, ctx.workspaceId, ...s, projectId, ctx.workspaceId, ...s, limit)
			.all<ActivityEvent>(),
	]);

	return [
		...issues.results,
		...comments.results,
		...statusChanges.results,
		...wikiPages.results,
		...sprints.results,
	];
}

export async function listProjectActivity(
	ctx: ServiceCtx,
	input: unknown
): Promise<ActivityEvent[]> {
	const parsed = ListProjectActivitySchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, since, limit } = parsed.data;

	const project = await ctx.db
		.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
		.bind(projectId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!project) throw new NotFoundError("Project not found");

	const all = await fetchActivityRows(ctx, projectId, since, limit);
	all.sort((a, b) => b.created_at - a.created_at);
	return all.slice(0, limit);
}
