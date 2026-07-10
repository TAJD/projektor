import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		key: text("key").notNull(),
		description: text("description"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		// Per-project agent WIP cap (PROJ-253). NULL = use the workspace default.
		agentWipLimit: integer("agent_wip_limit"),
	},
	(t) => ({
		wsIdx: index("projects_workspace_idx").on(t.workspaceId),
	})
);

export const taskTypes = sqliteTable(
	"task_types",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		color: text("color"),
		icon: text("icon"),
		position: integer("position").notNull().default(0),
		isDefault: integer("is_default").notNull().default(0),
	},
	(t) => ({
		wsKeyIdx: uniqueIndex("task_types_workspace_key_idx").on(t.workspaceId, t.key),
		wsIdx: index("task_types_workspace_idx").on(t.workspaceId),
	})
);

export const taskStatuses = sqliteTable(
	"task_statuses",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		category: text("category", { enum: ["todo", "in_progress", "done", "cancelled"] }).notNull(),
		color: text("color"),
		position: integer("position").notNull().default(0),
		isDefault: integer("is_default").notNull().default(0),
	},
	(t) => ({
		wsKeyIdx: uniqueIndex("task_statuses_workspace_key_idx").on(t.workspaceId, t.key),
		wsIdx: index("task_statuses_workspace_idx").on(t.workspaceId),
	})
);

export const issues = sqliteTable(
	"issues",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		number: integer("number").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull().default(""),
		status: text("status", {
			enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
		})
			.notNull()
			.default("backlog"),
		priority: text("priority", { enum: ["urgent", "high", "medium", "low", "none"] })
			.notNull()
			.default("none"),
		assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
		labels: text("labels", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		parentId: text("parent_id"),
		typeId: text("type_id").references(() => taskTypes.id, { onDelete: "set null" }),
		statusId: text("status_id").references(() => taskStatuses.id, { onDelete: "set null" }),
		statusCategory: text("status_category").notNull().default(""),
		sprintId: text("sprint_id"),
		createdById: text("created_by_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		// Stamped when the issue enters a done-category status, cleared when it
		// leaves (PROJ-212). Indexed for completed-date range filtering.
		completedAt: integer("completed_at"),
		// Flow metrics (PROJ-252): stamped once, the first time the issue enters the
		// corresponding state; never cleared (reopening is rework, not un-history).
		readyAt: integer("ready_at"),
		claimedAt: integer("claimed_at"),
		doneAt: integer("done_at"),
		// Review gating (PROJ-254): stamped when a completion report is submitted.
		completionReportAt: integer("completion_report_at"),
		// Collaboration-shape metrics (PROJ-328): write-once, same rules as ready_at/
		// claimed_at/done_at above. reviewBounceCount counts status bounces OUT of
		// review back to in-progress (never cleared, never re-derived from history).
		inReviewAt: integer("in_review_at"),
		reviewBounceCount: integer("review_bounce_count").notNull().default(0),
	},
	(t) => ({
		projectIdx: index("issues_project_idx").on(t.projectId),
		statusIdx: index("issues_status_idx").on(t.status),
		statusIdIdx: index("issues_status_id_idx").on(t.statusId),
		parentIdx: index("issues_parent_idx").on(t.parentId),
		assigneeIdx: index("issues_assignee_idx").on(t.assigneeId),
		wsStatusIdx: index("issues_workspace_status_idx").on(t.workspaceId, t.status),
		wsCategoryCreatedIdx: index("issues_workspace_category_created_idx").on(
			t.workspaceId,
			t.statusCategory,
			t.createdAt
		),
		wsCompletedIdx: index("idx_issues_workspace_completed").on(t.workspaceId, t.completedAt),
		wsReadyIdx: index("idx_issues_workspace_ready_at").on(t.workspaceId, t.readyAt),
		wsClaimedIdx: index("idx_issues_workspace_claimed_at").on(t.workspaceId, t.claimedAt),
		wsDoneIdx: index("idx_issues_workspace_done_at").on(t.workspaceId, t.doneAt),
		wsInReviewIdx: index("idx_issues_workspace_in_review_at").on(t.workspaceId, t.inReviewAt),
	})
);

export const issueComments = sqliteTable(
	"issue_comments",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		authorId: text("author_id")
			.notNull()
			.references(() => users.id),
		body: text("body").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		// Collaboration-shape metrics (PROJ-328): the authenticated principal type at
		// write time ("human" = Cloudflare Access JWT, "agent" = Bearer API token — see
		// middleware/auth.ts). NULL for comments written before this column existed.
		authorKind: text("author_kind", { enum: ["human", "agent"] }),
	},
	(t) => ({
		issueIdx: index("issue_comments_issue_idx").on(t.issueId),
	})
);

export const issueLinks = sqliteTable(
	"issue_links",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		sourceIssueId: text("source_issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		targetIssueId: text("target_issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		type: text("type", { enum: ["blocks", "relates_to", "duplicates"] }).notNull(),
		createdById: text("created_by_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		sourceIdx: index("issue_links_source_idx").on(t.sourceIssueId),
		targetIdx: index("issue_links_target_idx").on(t.targetIssueId),
	})
);

export const activity = sqliteTable(
	"activity",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		entityType: text("entity_type", { enum: ["issue", "wiki_page", "project", "group"] }).notNull(),
		entityId: text("entity_id").notNull(),
		actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		diff: text("diff", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		wsIdx: index("activity_workspace_idx").on(t.workspaceId),
		entityIdx: index("activity_entity_idx").on(t.entityType, t.entityId),
	})
);
