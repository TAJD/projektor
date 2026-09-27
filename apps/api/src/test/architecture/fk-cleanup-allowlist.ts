// PROJ-923: every FK declared with ON DELETE CASCADE / SET NULL in packages/db/migrations,
// and how the app handles it. D1 does not guarantee FK actions (PROJ-407), so a delete of
// the parent must clean up the child explicitly (cleanedBy: the code that does it, checked
// by fk-cleanup.node.test.ts to mention the child table), or be impossible/refused while
// children exist (guarded: why). Adding an FK with ON DELETE without an entry here fails
// the test — see AGENTS.md "Deletes never rely on FK cascades".

export type FkCleanupEntry = { cleanedBy: readonly string[] } | { guarded: string };

export const FK_CLEANUP_ALLOWLIST: Record<string, FkCleanupEntry> = {
	"activity -> users (SET NULL)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"activity -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"agent_messages -> agent_sessions (SET NULL)": {
		cleanedBy: [
			"index.ts#purgeExpiredRetentionData",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"agent_messages -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"agent_sessions -> api_tokens (SET NULL)": {
		cleanedBy: ["services/workspaces.ts#revokeToken", "services/user-tokens.ts#deleteUserToken"],
	},
	"agent_sessions -> issues (SET NULL)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"agent_sessions -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"api_tokens -> users (SET NULL)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"api_tokens -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"api_tokens_new -> users (SET NULL)": {
		guarded: "temporary table of the 0014 api_tokens rebuild (renamed to api_tokens)",
	},
	"api_tokens_new -> workspaces (CASCADE)": {
		guarded: "temporary table of the 0014 api_tokens rebuild (renamed to api_tokens)",
	},
	"attachments -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki.ts#deleteWikiPageAttachments",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"attachments -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"claim_conflicts -> agent_sessions (SET NULL)": {
		cleanedBy: [
			"index.ts#purgeExpiredRetentionData",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"claim_conflicts -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"claim_conflicts -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"custom_field_definitions -> projects (CASCADE)": {
		cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"custom_field_definitions -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"custom_field_values -> custom_field_definitions (CASCADE)": {
		guarded:
			"deleteCustomFieldDef refuses while any issue has a value for the field; project/workspace deletes remove values explicitly",
	},
	"custom_field_values -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"enabled_plugins -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"feedback -> feedback_sources (CASCADE)": {
		cleanedBy: [
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"feedback -> issues (SET NULL)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"feedback -> projects (CASCADE)": { cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"] },
	"feedback -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"feedback_sources -> projects (CASCADE)": {
		cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"feedback_sources -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"group_project_grants -> projects (CASCADE)": {
		cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"group_project_grants -> user_groups (CASCADE)": {
		cleanedBy: ["services/groups.ts#deleteGroup", "services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"issue_comments -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issue_file_claims -> agent_sessions (SET NULL)": {
		cleanedBy: [
			"index.ts#purgeExpiredRetentionData",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"issue_file_claims -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issue_file_claims -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"issue_gate_rejections -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issue_gate_rejections -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"issue_leases -> agent_sessions (CASCADE)": {
		cleanedBy: [
			"index.ts#purgeExpiredRetentionData",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"issue_leases -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issue_leases -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"issue_links -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issue_links -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"issues -> projects (CASCADE)": { cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"] },
	"issues -> sprints (SET NULL)": {
		cleanedBy: ["services/sprints.ts#deleteSprint", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"issues -> task_statuses (SET NULL)": {
		guarded: "deleteTaskStatus refuses while any issue uses the status",
	},
	"issues -> task_types (SET NULL)": {
		guarded: "deleteTaskType refuses while any issue uses the type",
	},
	"issues -> users (SET NULL)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"issues -> workspaces (CASCADE)": {
		guarded:
			"deleteWorkspace refuses while the workspace has projects, and every issue belongs to a project (removed by deleteProject)",
	},
	"projects -> workspaces (CASCADE)": {
		guarded: "deleteWorkspace refuses while the workspace has projects",
	},
	"provisioning_removals -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"provisioning_removals -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"sprints -> projects (CASCADE)": { cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"] },
	"sprints -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"task_statuses -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"task_types -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"user_group_members -> user_groups (CASCADE)": {
		cleanedBy: ["services/groups.ts#deleteGroup", "services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"user_group_members -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"user_groups -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_drafts -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"wiki_drafts -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki-drafts.ts#deleteWikiDraftsForPages",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_drafts -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_links -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki-links.ts#deleteWikiLinksForPages",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_links -> wiki_pages (SET NULL)": {
		cleanedBy: [
			"services/wiki-links.ts#repointIncomingLinks",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_links -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_notifications -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"wiki_notifications -> users (SET NULL)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"wiki_notifications -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_pages -> projects (CASCADE)": { cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"] },
	"wiki_pages -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_redirects -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki.ts#purgeExpiredWikiPages",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_redirects -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wiki_revisions -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki.ts#purgeExpiredWikiPages",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_watchers -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"wiki_watchers -> wiki_pages (CASCADE)": {
		cleanedBy: [
			"services/wiki-watchers.ts#deleteWikiWatchersForPages",
			"services/projects.ts#PROJECT_CLEANUP_SQL",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wiki_watchers -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"wip_cap_denials -> agent_sessions (SET NULL)": {
		cleanedBy: [
			"index.ts#purgeExpiredRetentionData",
			"services/workspaces.ts#WORKSPACE_CLEANUP_SQL",
		],
	},
	"wip_cap_denials -> issues (CASCADE)": {
		cleanedBy: ["services/issues.ts#deleteIssue", "services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"wip_cap_denials -> projects (CASCADE)": {
		cleanedBy: ["services/projects.ts#PROJECT_CLEANUP_SQL"],
	},
	"wip_cap_denials -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
	"workspace_members -> users (CASCADE)": {
		guarded: "users are never deleted: removeMember only removes the workspace membership row",
	},
	"workspace_members -> workspaces (CASCADE)": {
		cleanedBy: ["services/workspaces.ts#WORKSPACE_CLEANUP_SQL"],
	},
};
