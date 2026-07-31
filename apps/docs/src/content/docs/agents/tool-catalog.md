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

**93 tools across 21 domains.**

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
| `update_workspace` | Rename the current workspace. Admin+ only. |
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
| `list_issues` | List issues in the workspace, optionally filtered by status, priority, project, or assignee. Items omit `body` by default — pass includeBody:true to include it. Pass includeRollups:true to attach a `rollup` (child status counts: total/byStatus/done/remaining) to each item. |
| `get_issue` | Get a single issue by ID or project key + number (e.g. "PROJ-42") |
| `create_issue` | Create a new issue in a project |
| `update_issue` | Update an issue - status, priority, title, body, assignee, or labels. Review gating: pass agentSessionId to identify yourself as an agent; entering in_review as an agent requires completionReport. Agents CAN transition directly to done (no human approval gate) — but if the completionReport.verification isn't externally checkable (no CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review. |
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
| `search_wiki` | Full-text search over wiki pages (FTS5, BM25-ranked, title weighted above body). Returns match-anchored snippets highlighted with ** markers. type/tags/status are accepted for forward compatibility with the frontmatter (R6) and freshness (R7) work but are not yet implemented and are ignored if passed. |
| `get_wiki_page` | Get a wiki page by slug, including full content |
| `create_wiki_page` | Create a new wiki page |
| `update_wiki_page` | Update a wiki page by id or slug (saves a revision when content changes). Pass baseRevisionId (the current revision id from list_wiki_revisions/get_wiki_revision, or null if the page has never been revised) for conflict-safe writes: if the page advanced since baseRevisionId, the write is rejected with a structured conflict (currentRevisionId + a unified diff) instead of silently overwriting. Omitting baseRevisionId is DEPRECATED — it keeps today's last-write-wins behavior during the transition and will be rejected in a future version. |
| `delete_wiki_page` | Delete a wiki page by slug (not allowed for viewers). By default any child pages are promoted to the deleted page's parent; pass cascade=true to delete the whole subtree instead. |
| `wiki_tree` | Get the wiki page hierarchy as a nested tree, optionally filtered by project |
| `get_backlinks` | List pages that link to the given page via a resolved [[wikilink]] or same-workspace URL (id-backed, so renames never break a backlink). Each result includes a snippet of the citing text when it can still be located in the source page's current content. |
| `list_broken_wiki_links` | List unresolved wiki links in the workspace — [[Target]]/URL links whose target title or slug didn't match any page at write time. Useful as a maintenance queue. Note: a broken link does not auto-re-resolve if the missing page is created later — only backfill_wiki_links (or re-saving the linking page) re-resolves it. |
| `backfill_wiki_links` | One-time (idempotent, safe to re-run) recompute of the wiki_links graph for every existing page in the workspace. Owner/admin only. |
| `list_wiki_revisions` | List revision history for a wiki page |
| `get_wiki_revision` | Get the content of a specific wiki revision by its ID |

### Attachments

| Tool | Description |
|------|-------------|
| `list_attachments` | List attachments (files, wiki-page links, URLs) on an issue or wiki page |
| `get_attachment` | Get attachment metadata by id. For kind 'file' the bytes themselves are only available over REST (GET /api/files/:id) — binary content can't cross JSON-RPC. |
| `create_link_attachment` | Attach a wiki-page reference or an external URL to an issue or wiki page |
| `delete_attachment` | Delete an attachment by id |

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

### Feedback

| Tool | Description |
|------|-------------|
| `create_feedback_source` | Create a feedback source for a project. A source is a named, independently-credentialed feedback collection point (e.g. 'Onboarding survey', 'In-app NPS widget') that end-user feedback is submitted against. Returns a raw token that must be embedded in the user's own product code (a form or widget that POSTs to /api/feedback/submit with 'Authorization: Bearer <token>'). The raw token is shown exactly once and cannot be retrieved later — relay it to the user immediately. Admin/owner only. Optionally restrict browser callers with allowedOrigins (a list of allowed CORS origins); omit it for server-to-server callers. |
| `list_feedback_sources` | List a project's feedback sources. Each entry includes id, name, description, whether it is active, its allowed origins, a truncated token preview (never the raw token), and created/revoked timestamps. Admin/owner only. |
| `update_feedback_source` | Update a feedback source's name, description, or active state. Setting isActive to false is a kill switch: submissions against the source's token are immediately rejected (this is reversible — set it back to true to resume; contrast with revoke_feedback_source, which is permanent). Admin/owner only. |
| `rotate_feedback_source_token` | Generate a new token for a feedback source. Returns the new raw token once; the old token stops working immediately. The source's identity (id), name, description, and all its historical feedback are preserved — use this when a token has leaked or needs periodic rotation. Relay the new token to the user so they can update their product code. Admin/owner only. |
| `revoke_feedback_source` | Permanently revoke a feedback source. Its token stops working for good and it can never accept another submission (its historical feedback is retained for reference). To replace a revoked source, create a new one. Admin/owner only. |

### Flow metrics

| Tool | Description |
|------|-------------|
| `get_flow_metrics` | Time-in-state (leadTime, cycleTime, timeInProgress, reviewLatency, agingWip), collaboration-shape (humanInterventions, autonomyRatio, flowEfficiency — human attention, not an agent-vs-human split), volume-over-time (wipOverTime, throughputOverTime, cfdOverTime, arrivalVsCompletionOverTime, bugShareOverTime, bugTypeTracked), and factoryHealth (leaseExpiries, abandonedClaims, gateRejections, wipCapPressure) metrics for a project, computed from indexed transition timestamps. Full definitions: /projektor/agents/flow-metrics/. Two easily-confused pairs: autonomyRatio divides by cycleTime (claimed→done) while flowEfficiency divides by leadTime (ready→done), so flowEfficiency is always ≤ autonomyRatio when there's a ready→claimed queue; and bugTypeTracked:false (no 'bug' task type in the workspace) is distinct from a genuine 0% bug share. Bucketing defaults to weekly (current ISO week plus the preceding 5 weeks); pass granularity: 'day' for daily buckets. |

### Code heatmap

| Tool | Description |
|------|-------------|
| `get_code_heatmap` | Where work lands in the codebase, from file-claim history (issue_file_claims) — no git integration needed. Aggregates claims one path segment below `prefix` (omit for the top level), sized by distinctIssueCount (distinct issues that claimed a path under that segment, claimedAt within [since, until]) plus claimCount (raw claim count, including released ones). Each entry's `path` is the drill-down cursor: re-call with `prefix` set to it to see what's under a directory; `isLeaf` marks an entry that is itself a claimed file path, not a directory. Defaults to the current ISO week plus the preceding 5 weeks, matching get_flow_metrics. `mode` switches sizing between claim volume and claim contention (claim_conflicts). |

<!-- gen-mcp-catalog:end -->
