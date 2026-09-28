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

**122 tools across 22 domains.**

## Coordination

### Agent sessions

| Tool | Description | Kind |
|------|-------------|------|
| `start_work` | Register an agent session and claim an issue (plus files, if given) in one call — replaces register_agent + claim_issue + claim_files + post_message. All-or-nothing with compensating cleanup: on any conflict (same errors as claim_issue/claim_files) the session is ended and nothing is left claimed. If the process crashes mid-call, the same claims become reclaimable once the session's heartbeat goes stale (120s). | write |
| `finish_work` | Optionally transition an issue (completion-report rules apply, same as update_issue), then release every claim/lease the session holds and end it — replaces update_issue + release_issue + release_files + end_agent. | write |
| `register_agent` | Register an agent session, optionally linked to an issue | write |
| `heartbeat_agent` | Send a heartbeat to keep an agent session active | write |
| `end_agent` | End an agent session | write |
| `list_active_agents` | List active agent sessions in the workspace, optionally filtered by issue | read-only |

### File claims

| Tool | Description | Kind |
|------|-------------|------|
| `claim_files` | Claim one or more repo file paths for an issue so the parallel fleet can see what is taken | write |
| `release_files` | Release active file claims in the workspace, optionally scoped to an issue | destructive |
| `list_file_claims` | List active file claims in the workspace, optionally filtered by issue or path | read-only |

### Issue leases

| Tool | Description | Kind |
|------|-------------|------|
| `claim_issue` | Atomically lease an issue to an agent session so the parallel fleet doesn't double-work it. Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating. | write |
| `release_issue` | Release the active lease on an issue, optionally only if held by a given agent session | destructive |
| `list_issue_leases` | List active issue leases in the workspace, optionally filtered by issue or agent. Each entry's `live` flag is false when the holder stopped heartbeating (lease is reclaimable). | read-only |

### Agent messages

| Tool | Description | Kind |
|------|-------------|------|
| `post_message` | Post a coordination message to a workspace or issue channel so the agent fleet can communicate | write |
| `list_messages` | List coordination messages for a workspace or issue channel, in chronological order | read-only |

### Workflow spec

| Tool | Description | Kind |
|------|-------------|------|
| `get_workflow` | Fetch the canonical agent workflow spec: definition of ready, state machine, human gates, completion report requirements, and WIP limits. Call this before claiming work. | read-only |

### Playbooks

| Tool | Description | Kind |
|------|-------------|------|
| `list_playbooks` | List shipped agent playbooks — generic, reusable working patterns (e.g. epic-goal). Returns name/title/description/whenToUse for each; call get_playbook(name) for the full body. | read-only |
| `get_playbook` | Fetch a shipped playbook's full content by name. | read-only |
| `compose_playbook` | Fill a playbook template server-side using live project data (epic title, open child count, agent WIP limit). For "epic-goal": params.epicRef is required; params.variant (bounded\|full, default bounded), params.reviewModel (default "opus"), params.cadence (default 2) are optional. | write |

## Project data

### Workspaces & members

| Tool | Description | Kind |
|------|-------------|------|
| `list_workspaces` | List all workspaces the authenticated user belongs to, with their role in each | read-only |
| `create_workspace` | Create a new workspace and add the caller as owner. Seeds default task types, statuses, and custom fields. | write |
| `delete_workspace` | Permanently delete a workspace. Owner-only. The default workspace cannot be deleted. All projects must be removed first. | destructive |
| `update_workspace` | Rename the current workspace. Admin+ only. | write |
| `list_members` | List all members of the current workspace with their roles | read-only |
| `invite_member` | Invite a user to the workspace by email. Admin+ only. Creates the user record if they do not exist yet. | write |
| `remove_member` | Remove a member from the workspace. Owner only. Cannot remove yourself. | destructive |
| `update_member_role` | Change a workspace member's role. Owner only. | destructive |
| `get_workspace_brand` | Get the current workspace's white-label branding overrides (display name, accent colors, logo, font). Unset fields are null. | read-only |
| `update_workspace_brand` | Update the current workspace's white-label branding overrides. Admin+ only. Pass a field as null to clear it back to the deploy-level default; omit a field to leave it unchanged. | write |

### Groups & access

| Tool | Description | Kind |
|------|-------------|------|
| `list_groups` | List access groups. Owner/admin see all groups in the workspace; other members see only groups they belong to. | read-only |
| `get_group` | Get an access group with its members and project grants | read-only |
| `list_member_groups` | List every workspace member with the access groups they belong to (owner/admin only). Members with no groups appear with an empty list — the pending/default-deny state. | read-only |
| `create_group` | Create an access group (owner/admin only) | write |
| `update_group` | Rename an access group or change its description (owner/admin only) | write |
| `delete_group` | Delete an access group; its memberships and project grants cascade (owner/admin only) | destructive |
| `add_group_member` | Add a workspace member to an access group (owner/admin only) | write |
| `remove_group_member` | Remove a member from an access group (owner/admin only) | destructive |
| `set_group_grant` | Grant an access group a role on a project (upsert — changes the role if a grant already exists). Owner/admin only. | write |
| `remove_group_grant` | Remove an access group's grant on a project (owner/admin only) | destructive |

### Projects

| Tool | Description | Kind |
|------|-------------|------|
| `list_projects` | List projects in the workspace. Archived projects are excluded by default. | read-only |
| `create_project` | Create a new project in the workspace | write |
| `get_project` | Get a project by ID | read-only |
| `update_project` | Update a project name, description, or archived state (owner/admin only). Set archived: true to hide it from the default project list, false to restore it. | write |
| `delete_project` | Delete a project and all its issues (owner only) | destructive |

### Project activity

| Tool | Description | Kind |
|------|-------------|------|
| `list_project_activity` | List recent activity events for a project across issues, comments, wiki pages, and sprints. Returns events ordered most-recent first. | read-only |

### Issues

| Tool | Description | Kind |
|------|-------------|------|
| `list_issues` | List issues in the workspace, optionally filtered by status, priority, project, or assignee. Items omit `body` by default — pass includeBody:true to include it. Pass includeRollups:true to attach a `rollup` (child status counts: total/byStatus/done/remaining) to each item (a zero rollup is omitted unless verbose:true). Omitted keys are null/empty/false; pass verbose:true for the full shape. | read-only |
| `get_issue` | Get a single issue by ID or project key + number (e.g. "PROJ-42"). Omitted keys are null/empty/false; pass verbose:true for the full shape. | read-only |
| `get_issues` | Fetch up to 50 issues in one call, by ref (e.g. PROJ-42) and/or id. Cheaper than repeated get_issue calls for triage. Items carry customFields but no rollup/links/assignee_name, and omit `body` unless includeBody:true. Returned in the order refs/ids were given; `missing` lists (once each) any requested ref/id that didn't resolve or isn't visible to you. Omitted keys are null/empty/false; pass verbose:true for the full shape. | read-only |
| `create_issue` | Create a new issue in a project. For an issue an agent should be able to pick up autonomously, the body should state acceptance criteria and scope (files/components) — see get_workflow's definition of ready. get_prioritized_issues excludes issues missing these by default. Verification isn't part of the readiness bar (PROJ-738) — it's required later, in the completionReport when entering review/done. | write |
| `update_issue` | Update an issue — status, priority, title, body, assignee, or labels. Review gating: pass agentSessionId to identify yourself as an agent; entering in_review as an agent requires completionReport. Agents CAN transition directly to done (no human approval gate) — but if the completionReport.verification isn't externally checkable (no CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review. | write |
| `search_issues` | Search issues by keyword in title or body | read-only |
| `delete_issue` | Delete an issue by ID or ref (e.g. PROJ-42) | destructive |
| `get_prioritized_issues` | Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + inverse story points. Useful for deciding what to work on next. By default, issues that fail the definition-of-ready check (missing acceptance criteria or scope/files) are excluded. If none of the open issues pass, the ranked (not-ready) list is returned anyway with `degraded: true` on the response and `needsGrooming`/`missingCriteria` on each issue, rather than an empty array — empty otherwise means "no open work", which would be a lie. | read-only |

### Issue links

| Tool | Description | Kind |
|------|-------------|------|
| `create_issue_link` | Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates) | write |
| `delete_issue_link` | Delete an issue link by ID | destructive |
| `list_issue_links` | List all links for an issue (shows effective type from this issue's perspective) | read-only |

### Comments

| Tool | Description | Kind |
|------|-------------|------|
| `list_comments` | List comments on an issue | read-only |
| `add_comment` | Add a comment to an issue | write |
| `update_comment` | Update the body of a comment (author only) | write |
| `delete_comment` | Delete a comment (author, admin, or owner) | destructive |

### Wiki

| Tool | Description | Kind |
|------|-------------|------|
| `list_wiki_pages` | List wiki pages in the workspace, optionally filtered by parent, project, frontmatter type/status, or tags (any-of match) | read-only |
| `search_wiki` | Full-text search over wiki pages (FTS5, BM25-ranked, title weighted above body). Returns match-anchored snippets highlighted with ** markers, plus a computed `freshness` ({state, staleSince} or null if the page has no verify_interval/status signal) per result. type/status/tags filter on the denormalised frontmatter columns (R6). Results are demoted (ranked below everything else, ties broken by bm25 within each tier) when the page is computed-stale/unverified OR has an explicit status: stale\|deprecated (R7). | read-only |
| `get_wiki_page` | Get a wiki page by slug, including full content. Pass the returned `revisionId` as `baseRevisionId` when you update or patch the page. | read-only |
| `create_wiki_page` | Create a new wiki page. `content` may start with an optional YAML frontmatter block (`---\ntype: runbook\ntags: [foo]\nstatus: draft\n---\n...`) — type (freeform; well-known values runbook\|adr\|spec\|note), tags[], status (draft\|current\|stale\|deprecated), verified_at, verified_by, owners[], verify_interval (days), template (boolean) are parsed and denormalised for filtering. Invalid frontmatter (bad status/enum, wrong type, unrecognised key) is rejected with a structured error, not ignored. Alternatively, pass `templateSlug` (from list_wiki_templates) to seed this page's content from an existing template page — its `template: true` flag is stripped from the seeded content (the new page is not itself a template). `templateSlug` and `content` are mutually exclusive; a `templateSlug` that doesn't resolve to a page flagged template:true is rejected. | write |
| `update_wiki_page` | Update a wiki page by id or slug (saves a revision when content changes). Pass baseRevisionId (the current revision id from list_wiki_revisions/get_wiki_revision, or null if the page has never been revised) for conflict-safe writes: if the page advanced since baseRevisionId, the write is rejected with a structured conflict (currentRevisionId + a unified diff) instead of silently overwriting. Omitting baseRevisionId is DEPRECATED — it keeps today's last-write-wins behavior during the transition and will be rejected in a future version. The revision pointer only advances on content edits, so baseRevisionId doesn't cover title/slug/parentId-only changes; those are last-write-wins against writes that finished before your call, but any write that lands while your call is in flight returns a 409. `content` may include a YAML frontmatter block (see create_wiki_page); it's re-parsed on every content edit, replacing the page's previously-stored metadata. Omitting `content` leaves the page's existing frontmatter metadata unchanged. | write |
| `patch_wiki_page` | Section-addressed patch operations on a wiki page's markdown, by id or slug. Sections are addressed by exact heading text (a `#`..`######` line and everything up to the next heading; `#` lines inside fenced code blocks or the YAML frontmatter block are not headings). A heading that appears more than once on the page is ambiguous and rejected — patch targets must be unique. Ops: append_to_section (add text at the end of the section's body), replace_section (replace the section's body, heading kept), insert_after_heading (insert text directly under the heading, before the existing body), append_to_page (append at the very end of the document, no heading needed), set_frontmatter (merge `values` into the page's YAML frontmatter block without touching the rest of the content — a key set to null is removed; a page with no frontmatter block gains one). baseRevisionId is required (the current revision id from list_wiki_revisions/get_wiki_revision, or null if never revised) — conflict detection is SECTION-scoped, not whole-page: two agents patching different sections never conflict, even if the page's revision advanced between their reads — only the SAME section changing underneath the caller conflicts (append_to_page and set_frontmatter skip this check; baseRevisionId is only validated as belonging to the page). A heading miss (never existed, or deleted/renamed since baseRevisionId) returns the page's current headings so a caller can retry against reality. Creates a revision like update_wiki_page; ops other than set_frontmatter leave frontmatter metadata untouched beyond reparsing it (never stamps verified_at). | write |
| `delete_wiki_page` | Delete a wiki page by slug (not allowed for viewers). By default any child pages are promoted to the deleted page's parent; pass cascade=true to delete the whole subtree instead. | destructive |
| `wiki_tree` | Get the wiki page hierarchy as a nested tree, optionally filtered by project | read-only |
| `get_backlinks` | List pages that link to the given page via a resolved [[wikilink]] or same-workspace URL (id-backed, so renames never break a backlink). Each result includes a snippet of the citing text when it can still be located in the source page's current content. | read-only |
| `list_broken_wiki_links` | List unresolved wiki links in the workspace — [[Target]]/URL links whose target title or slug didn't match any page at write time. Useful as a maintenance queue. A broken link auto-resolves when a page matching its title/slug is created, renamed to match it, or restored from the trash (PROJ-814); backfill_wiki_links (or re-saving the linking page) also still re-resolves it. | read-only |
| `backfill_wiki_links` | Idempotent, safe-to-re-run recompute of the wiki_links graph for pages in the workspace, one page-budget-sized chunk per call (default 200, max 500) so it can run incrementally and resume after a timeout. Skips trashed pages. Pass back `nextCursor` as `cursor` to continue; call repeatedly until `nextCursor` is null. `updatedSince` (unix seconds) limits the scope to pages touched at/after that time. Owner/admin only. | write |
| `list_wiki_revisions` | List revision history for a wiki page | read-only |
| `get_wiki_revision` | Get the content of a specific wiki revision by its ID | read-only |
| `get_wiki_revision_diff` | Server-side unified diff between one revision (revisionId) and either another revision or the page's current content. `against` is a revision id or the literal string "current" (default when omitted). Same unified diff format as update_wiki_page/patch_wiki_page's conflict responses (--- base / +++ current, @@ hunk headers). | read-only |
| `verify_wiki_page` | Stamp a wiki page as freshly verified — sets its frontmatter verified_at to now and verified_by to the CALLING user's email (never caller-supplied). Rewrites the page's frontmatter block (creating one if it had none) and records a revision, same as any other content edit — including its conflict check, so a concurrent edit racing the stamp is rejected rather than reverted. Not allowed for viewers. | write |
| `list_stale_pages` | Maintenance queue of wiki pages that need re-verification: computed-stale (verify_interval elapsed since verified_at), unverified (verify_interval declared but never verified), or explicitly status: stale\|deprecated. Same rule search_wiki uses to demote results (R7). | read-only |
| `list_wiki_templates` | List pages flagged as templates (frontmatter `template: true`) — the picker create_wiki_page's `templateSlug` draws from. Templates are conventionally workspace-global (living under a workspace 'Templates' page) but a project-scoped template is allowed and follows the same project-visibility rule as any other project-scoped page. | read-only |
| `watch_wiki_page` | Watch a wiki page by id or slug — its changes (create is n/a here since the page already exists, update/patch/verify/restore/delete) will generate a per-user notification (list_wiki_notifications). Pass subtree=true to also watch every page currently OR LATER nested under this one (resolved dynamically by walking the page hierarchy at notify time, not a one-time snapshot). Calling this again for the same page updates the subtree flag rather than creating a duplicate watch. Template pages (frontmatter template: true) never generate notifications even if watched directly or via a subtree. | write |
| `unwatch_wiki_page` | Stop watching a wiki page by id or slug (a no-op if not currently watched). | write |
| `list_wiki_watches` | List the pages the calling user is currently watching. | read-only |
| `list_wiki_notifications` | List the calling user's wiki watch notifications (newest first). Each entry records the page (denormalised slug/title, so a notification about a page that's since been deleted still shows what it was about), the action (created\|updated\|deleted), the actor, and whether it's been read. | read-only |
| `mark_wiki_notifications_read` | Mark wiki notifications as read, by id, or all: true for every unread one. | write |
| `list_wiki_changes` | Cheap delta feed of wiki page changes since a unix-seconds timestamp — for agents polling 'what changed' instead of re-fetching/re-searching the whole wiki. `since` is EXCLUSIVE; poll again using the response's `nextSince`, not a locally-computed timestamp, so changes landing on the same second as the cutoff are never missed or double-delivered. Defaults to every wiki page the caller can see (same visibility as list_wiki_pages/search_wiki) — pass watchedOnly=true to narrow to pages the caller is watching (directly or via a subtree watch). A `deleted` entry's slug/title/projectId reflect the page as it was just before deletion (the row itself is gone). | read-only |
| `get_wiki_draft` | Get the calling user's saved server-side draft for a wiki page by id or slug (server-side, so a draft survives a device switch). Returns null if there is no draft. `baseRevisionId` is the page's latest revision id as of when the draft was started — pass it straight through to update_wiki_page/patch_wiki_page's own baseRevisionId when publishing, so a stale draft hits the normal conflict response instead of silently clobbering someone else's newer edit. | read-only |
| `save_wiki_draft` | Save (upsert) the calling user's draft for a wiki page by id or slug. One draft per (page, user) — calling this again overwrites the previous draft rather than creating a new one. Not a revision and not visible to other users. Callers should debounce their own call frequency (e.g. ~1s after the last edit) — this tool does no server-side throttling. | write |
| `discard_wiki_draft` | Delete the calling user's draft for a wiki page by id or slug (a no-op if there is none). Call this after a successful publish, or whenever the user explicitly discards unsaved changes. | destructive |
| `list_wiki_trash` | List trashed (soft-deleted) wiki pages in the workspace, optionally scoped to a project. Same visibility rule as list_wiki_pages — a project-scoped trashed page only appears for callers who could see that project. Each result includes `purgeAfter` (unix seconds) — the page is permanently removed by purge_wiki_trash once that time passes (30 days after deletion). | read-only |
| `undelete_wiki_page` | Restore a trashed wiki page by ID (not slug — trashed pages can share a now-recycled slug; use list_wiki_trash to find the ID). Requires the same permission as delete_wiki_page. If this page was cascade-trashed together with descendants, the whole subtree is restored as one batch — the response's restoredCount reports how many pages came back. Rejected with a structured conflict (no partial restore) if the ID's own slug OR any descendant's slug has since been taken by another live page — the conflict names the colliding slug; rename that page first, then retry. The restored page's parent may itself still be trashed; if so the page appears as a root until the parent is also restored. | write |
| `purge_wiki_trash` | Permanently remove every wiki page in the workspace that's been trashed for at least 30 days — deletes R2 attachment objects, wiki_revisions/wiki_links/wiki_watchers/wiki_drafts/wiki_redirects rows, and the page row itself, re-parenting any live child left pointing at a purged page. Irreversible. Owner/admin only. Also runs automatically once daily via a Workers Cron Trigger — call this manually only to force an off-cycle purge. | destructive |

### Attachments

| Tool | Description | Kind |
|------|-------------|------|
| `list_attachments` | List attachments (files, wiki-page links, URLs) on an issue or wiki page | read-only |
| `get_attachment` | Get attachment metadata by id. For kind 'file' the bytes themselves are only available over REST (GET /api/files/:id) — binary content can't cross JSON-RPC. | read-only |
| `create_link_attachment` | Attach a wiki-page reference or an external URL to an issue or wiki page | write |
| `delete_attachment` | Delete an attachment by id | destructive |

### Task types

| Tool | Description | Kind |
|------|-------------|------|
| `list_task_types` | List all task types configured for the workspace | read-only |
| `create_task_type` | Create a new task type for the workspace (owner/admin only) | write |
| `update_task_type` | Update a task type (owner/admin only) | write |
| `delete_task_type` | Delete a task type (owner/admin only). Fails if the type is in use by any issues. | destructive |

### Task statuses

| Tool | Description | Kind |
|------|-------------|------|
| `list_task_statuses` | List all task statuses configured for the workspace | read-only |
| `create_task_status` | Create a new task status for the workspace (owner/admin only) | write |
| `update_task_status` | Update a task status (owner/admin only) | write |
| `delete_task_status` | Delete a task status (owner/admin only). Fails if the status is in use or is the default. | destructive |

### Custom fields

| Tool | Description | Kind |
|------|-------------|------|
| `list_custom_field_defs` | List all custom field definitions for the workspace | read-only |
| `create_custom_field_def` | Create a new custom field definition (owner/admin only) | write |
| `update_custom_field_def` | Update a custom field definition label or options (owner/admin only) | write |
| `delete_custom_field_def` | Delete a custom field definition (owner/admin only). Fails if any issues have values for this field. | destructive |

### Sprints

| Tool | Description | Kind |
|------|-------------|------|
| `list_sprints` | List sprints for a project, ordered by creation date | read-only |
| `get_sprint` | Get a sprint by ID | read-only |
| `create_sprint` | Create a new sprint in a project | write |
| `update_sprint` | Update sprint fields — name, goal, status, start/end dates | write |
| `complete_sprint` | Mark an active sprint as completed | write |
| `delete_sprint` | Delete a sprint (issues in the sprint will have their sprint_id cleared) | destructive |
| `move_issues_to_sprint` | Bulk move issues into a sprint by setting their sprint_id | write |

### Feedback

| Tool | Description | Kind |
|------|-------------|------|
| `create_feedback_source` | Create a feedback source for a project. A source is a named, independently-credentialed feedback collection point (e.g. 'Onboarding survey', 'In-app NPS widget') that end-user feedback is submitted against. Returns a raw token that must be embedded in the user's own product code (a form or widget that POSTs to /api/feedback/submit with 'Authorization: Bearer <token>'). The raw token is shown exactly once and cannot be retrieved later — relay it to the user immediately. Admin/owner only. Optionally restrict browser callers with allowedOrigins (a list of allowed CORS origins); omit it for server-to-server callers. | write |
| `list_feedback_sources` | List a project's feedback sources. Each entry includes id, name, description, whether it is active, its allowed origins, a truncated token preview (never the raw token), and created/revoked timestamps. Admin/owner only. | read-only |
| `get_feedback_source` | Look up a single feedback source by id, including its projectId. Workspace-scoped: a sourceId from another workspace 404s. Any workspace member can read. | read-only |
| `update_feedback_source` | Update a feedback source's name, description, or active state. Setting isActive to false is a kill switch: submissions against the source's token are immediately rejected (this is reversible — set it back to true to resume; contrast with revoke_feedback_source, which is permanent). Admin/owner only. | write |
| `rotate_feedback_source_token` | Generate a new token for a feedback source. Returns the new raw token once; the old token stops working immediately. The source's identity (id), name, description, and all its historical feedback are preserved — use this when a token has leaked or needs periodic rotation. Relay the new token to the user so they can update their product code. Admin/owner only. | destructive |
| `revoke_feedback_source` | Permanently revoke a feedback source. Its token stops working for good and it can never accept another submission (its historical feedback is retained for reference). To replace a revoked source, create a new one. Admin/owner only. | destructive |
| `list_feedback` | List a project's submitted feedback (read/triage, not source management). Each entry includes rating, ratingScale, body, submitterLabel, sourceUrl, appVersion, status ('new'/'reviewed'/'actioned'), linkedIssueId (set once converted to an issue), and createdAt. Optionally filter by status or sourceId. Any project member (including viewer) can read. | read-only |
| `update_feedback_status` | Update a feedback item's triage status ('new'/'reviewed'/'actioned'). Member+ (not viewer). | write |
| `convert_feedback_to_issue` | Convert a feedback item into a tracked issue. The issue title comes from the feedback body (or a rating-based fallback when there's no body); the feedback item is stamped linkedIssueId and its status set to 'actioned'. Rejects (409) if the item was already converted. Member+ (not viewer). | write |

### Flow metrics

| Tool | Description | Kind |
|------|-------------|------|
| `get_flow_metrics` | Time-in-state (leadTime, cycleTime, timeInProgress, reviewLatency, agingWip), collaboration-shape (humanInterventions, autonomyRatio, flowEfficiency — human attention, not an agent-vs-human split), volume-over-time (wipOverTime, throughputOverTime, cfdOverTime, arrivalVsCompletionOverTime, bugShareOverTime, bugTypeTracked), and factoryHealth (leaseExpiries, abandonedClaims, gateRejections, wipCapPressure) metrics for a project. Full definitions: /projektor/agents/flow-metrics/. Two easily-confused pairs: autonomyRatio divides by cycleTime (claimed→done) while flowEfficiency divides by leadTime (ready→done), so flowEfficiency is always ≤ autonomyRatio when there's a ready→claimed queue; and bugTypeTracked:false (no 'bug' task type in the workspace) is distinct from a genuine 0% bug share. Bucketing defaults to weekly (current ISO week plus the preceding 5 weeks); pass granularity: 'day' for daily buckets. | read-only |

### Code heatmap

| Tool | Description | Kind |
|------|-------------|------|
| `get_code_heatmap` | Where work lands in the codebase, from file-claim history — no git integration needed. Aggregates claims one path segment below `prefix` (omit for the top level), sized by distinctIssueCount (distinct issues that claimed a path under that segment, claimedAt within [since, until]) plus claimCount (raw claim count, including released ones). Each entry's `path` is the drill-down cursor: re-call with `prefix` set to it to see what's under a directory; `isLeaf` marks an entry that is itself a claimed file path, not a directory. Defaults to the current ISO week plus the preceding 5 weeks, matching get_flow_metrics. `mode` switches sizing between claim volume and claim contention (claim_conflicts). | read-only |

<!-- gen-mcp-catalog:end -->
