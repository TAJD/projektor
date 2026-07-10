---
title: "MCP tool catalog"
description: "Every MCP tool Projektor exposes, generated from source."
sidebar:
  order: 2
---
Every MCP tool Projektor exposes, grouped by domain, with one-line descriptions.
All inputs and outputs are JSON. The table below is generated from
`apps/api/src/mcp/*.ts` and freshness-checked by CI, so it always matches the
running server.

<!-- gen-mcp-catalog:start - generated block; run `pnpm --filter @projektor/api gen:catalog` to refresh -->

**79 tools across 18 domains.**

## Coordination

### Agent sessions

| Tool | Description |
|------|-------------|
| `register_agent` | Register an agent session, optionally linked to an issue |
| `heartbeat_agent` | Send a heartbeat to keep an agent session active |
| `end_agent` | End an agent session |
| `list_active_agents` | List active agent sessions in the workspace, optionally filtered by issue |

### File claims

| Tool | Description |
|------|-------------|
| `claim_files` | Claim one or more repo file paths for an issue so the parallel fleet can see what is taken |
| `release_files` | Release active file claims in the workspace, optionally scoped to an issue |
| `list_file_claims` | List active file claims in the workspace, optionally filtered by issue or path |

### Issue leases

| Tool | Description |
|------|-------------|
| `claim_issue` | Atomically lease an issue to an agent session so the parallel fleet doesn't double-work it. Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating. |
| `release_issue` | Release the active lease on an issue, optionally only if held by a given agent session |
| `list_issue_leases` | List active issue leases in the workspace, optionally filtered by issue or agent. Each entry's `live` flag is false when the holder stopped heartbeating (lease is reclaimable). |

### Agent messages

| Tool | Description |
|------|-------------|
| `post_message` | Post a coordination message to a workspace or issue channel so the agent fleet can communicate |
| `list_messages` | List coordination messages for a workspace or issue channel, in chronological order |

### Workflow spec

| Tool | Description |
|------|-------------|
| `get_workflow` | Fetch the canonical agent workflow spec: definition of ready, state machine, human gates, completion report requirements, and WIP limits. Call this before claiming work. |

## Project data

### Workspaces & members

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces the authenticated user belongs to, with their role in each |
| `create_workspace` | Create a new workspace and add the caller as owner. Seeds default task types, statuses, and custom fields. |
| `delete_workspace` | Permanently delete a workspace. Owner-only. The default workspace cannot be deleted. All projects must be removed first. |
| `list_members` | List all members of the current workspace with their roles |
| `invite_member` | Invite a user to the workspace by email. Admin+ only. Creates the user record if they do not exist yet. |
| `remove_member` | Remove a member from the workspace. Owner only. Cannot remove yourself. |
| `update_member_role` | Change a workspace member's role. Owner only. |

### Groups & access

| Tool | Description |
|------|-------------|
| `list_groups` | List access groups. Owner/admin see all groups in the workspace; other members see only groups they belong to. |
| `get_group` | Get an access group with its members and project grants |
| `list_member_groups` | List every workspace member with the access groups they belong to (owner/admin only). Members with no groups appear with an empty list — the pending/default-deny state. |
| `create_group` | Create an access group (owner/admin only) |
| `update_group` | Rename an access group or change its description (owner/admin only) |
| `delete_group` | Delete an access group; its memberships and project grants cascade (owner/admin only) |
| `add_group_member` | Add a workspace member to an access group (owner/admin only) |
| `remove_group_member` | Remove a member from an access group (owner/admin only) |
| `set_group_grant` | Grant an access group a role on a project (upsert — changes the role if a grant already exists). Owner/admin only. |
| `remove_group_grant` | Remove an access group's grant on a project (owner/admin only) |

### Projects

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects in the workspace |
| `create_project` | Create a new project in the workspace |
| `get_project` | Get a project by ID |
| `update_project` | Update a project name or description (owner/admin only) |
| `delete_project` | Delete a project and all its issues (owner only) |

### Project activity

| Tool | Description |
|------|-------------|
| `list_project_activity` | List recent activity events for a project across issues, comments, wiki pages, and sprints. Returns events ordered most-recent first. |

### Issues

| Tool | Description |
|------|-------------|
| `list_issues` | List issues in the workspace, optionally filtered by status, priority, project, or assignee |
| `get_issue` | Get a single issue by ID or project key + number (e.g. "PROJ-42") |
| `create_issue` | Create a new issue in a project |
| `update_issue` | Update an issue - status, priority, title, body, assignee, or labels. Review gating (PROJ-254): pass agentSessionId to identify yourself as an agent; entering in_review as an agent requires completionReport, and only a human can transition to done. |
| `search_issues` | Search issues by keyword in title or body |
| `delete_issue` | Delete an issue by ID |
| `get_prioritized_issues` | Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + inverse story points. Useful for deciding what to work on next. By default, issues that fail the definition-of-ready check (missing acceptance criteria, scope/files, or verification) are excluded. |

### Issue links

| Tool | Description |
|------|-------------|
| `create_issue_link` | Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates) |
| `delete_issue_link` | Delete an issue link by ID |
| `list_issue_links` | List all links for an issue (shows effective type from this issue's perspective) |

### Comments

| Tool | Description |
|------|-------------|
| `list_comments` | List comments on an issue |
| `add_comment` | Add a comment to an issue |
| `update_comment` | Update the body of a comment (author only) |
| `delete_comment` | Delete a comment (author, admin, or owner) |

### Wiki

| Tool | Description |
|------|-------------|
| `list_wiki_pages` | List wiki pages in the workspace, optionally filtered by parent or project |
| `search_wiki` | Search wiki pages by keyword in title or content |
| `get_wiki_page` | Get a wiki page by slug, including full content |
| `create_wiki_page` | Create a new wiki page |
| `update_wiki_page` | Update a wiki page by id or slug (saves a revision when content changes) |
| `delete_wiki_page` | Delete a wiki page by slug (not allowed for viewers) |
| `wiki_tree` | Get the wiki page hierarchy as a nested tree, optionally filtered by project |
| `list_wiki_revisions` | List revision history for a wiki page |
| `get_wiki_revision` | Get the content of a specific wiki revision by its ID |

### Task types

| Tool | Description |
|------|-------------|
| `list_task_types` | List all task types configured for the workspace |
| `create_task_type` | Create a new task type for the workspace (owner/admin only) |
| `update_task_type` | Update a task type (owner/admin only) |
| `delete_task_type` | Delete a task type (owner/admin only). Fails if the type is in use by any issues. |

### Task statuses

| Tool | Description |
|------|-------------|
| `list_task_statuses` | List all task statuses configured for the workspace |
| `create_task_status` | Create a new task status for the workspace (owner/admin only) |
| `update_task_status` | Update a task status (owner/admin only) |
| `delete_task_status` | Delete a task status (owner/admin only). Fails if the status is in use or is the default. |

### Custom fields

| Tool | Description |
|------|-------------|
| `list_custom_field_defs` | List all custom field definitions for the workspace |
| `create_custom_field_def` | Create a new custom field definition (owner/admin only) |
| `update_custom_field_def` | Update a custom field definition label or options (owner/admin only) |
| `delete_custom_field_def` | Delete a custom field definition (owner/admin only). Fails if any issues have values for this field. |

### Sprints

| Tool | Description |
|------|-------------|
| `list_sprints` | List sprints for a project, ordered by creation date |
| `get_sprint` | Get a sprint by ID |
| `create_sprint` | Create a new sprint in a project |
| `update_sprint` | Update sprint fields - name, goal, status, start/end dates |
| `complete_sprint` | Mark an active sprint as completed |
| `delete_sprint` | Delete a sprint (issues in the sprint will have their sprint_id cleared) |
| `move_issues_to_sprint` | Bulk move issues into a sprint by setting their sprint_id |

### Flow metrics

| Tool | Description |
|------|-------------|
| `get_flow_metrics` | Lead time (ready→done), cycle time (claimed→done), WIP over time, and throughput over time for a project, computed from indexed transition timestamps. Measure flow before tuning WIP limits. |

<!-- gen-mcp-catalog:end -->
