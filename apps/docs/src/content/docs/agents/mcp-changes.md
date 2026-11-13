---
title: "MCP changes by release"
description: "What changed in Projektor's MCP tools in each release: reshaped results, new validation, new tools and parameters, and how to get the old behaviour back."
sidebar:
  order: 7
---
Agents read Projektor's tool descriptions when they connect, so a new release reaches
them on their next connection. Some MCP clients cache the tool list for a whole session:
reconnect, or restart the client, after you upgrade. Prompts, scripts or skills written
against an older release may rely on fields or errors that have since changed. This page
lists those changes, newest first. The REST API (`/api/*`) is not covered here: its rows
keep the full shape.

## v0.11.1

- **Closing with a token is audited with or without `agentSessionId`.** A `done`
  transition made with an API token or OAuth grant is treated as agent-initiated when it
  closes an issue an agent has leased, or supplies a `completionReport`. Freeform
  verification then sets `needsAudit:true`, where leaving out `agentSessionId` used to
  avoid it. To stay unflagged, put a PR, CI run or commit link in
  `completionReport.verification`.
- **A bare commit SHA must mix digits and letters to count as evidence.** A plain number
  or a hex-looking word in `verification` no longer clears the audit. A link is the
  reliable form.
- **`list_comments` items carry `agentSessionId`** when an agent session wrote the
  comment (completion reports, and comments sent with `create_issue` or `update_issue`
  alongside an `agentSessionId`). Other comments are unchanged.
- **`mark_wiki_notifications_read` accepts its full 200 ids.** More than about 98 used to
  fail on a deployed instance.
- **`list_issues` `priorities` ignores unknown and repeated values.** A filter made up
  only of unknown values still matches nothing.

## v0.11.0

- **`list_messages` returns `{items, next?}`** like the other paged lists, instead of
  `{items, nextCursor}`. Pass `next` back as `cursor`; the cursor value is unchanged. The
  REST endpoint still returns `nextCursor`.

## v0.10.2

- **`release_files` takes a session name as `agentId`.** It resolves among your
  credential's active sessions, live ones first. A name that matches none, or several,
  is a validation error that lists them. `issueRef` and `issue_ref` now name the issue
  on every tool that takes one.
- **`get_flow_metrics` collaboration and health figures were redefined.** The REST
  `/flow-metrics` endpoint changed too. Figures from earlier releases aren't comparable.
  See [Flow metrics](/projektor/agents/flow-metrics/).
  - `humanInterventions` counts review decisions (bounces out of review plus the
    sign-off), not comments.
  - `autonomyRatio` and `flowEfficiency` skip issues that never held an agent lease.
  - `factoryHealth.abandonedClaims` counts sessions that went silent holding claims,
    once each, rather than every claim a clean `finish_work` left open.

## v0.10.1

- **`fields` returns `labels` as an array.** `list_issues`, `get_issue` and `get_issues`
  with `fields` naming `labels` returned the raw JSON string (`"[\"a\"]"`). They now
  return an array (`[]` if the issue has none), the same as the `full` view.
  `verbose:true` still returns the raw row.
- Label search, label filters, `get_prioritized_issues` and the project list read far
  fewer rows. Results are unchanged.

## v0.10.0

### Results that changed shape

| Tool | Before | Now | Old shape |
|---|---|---|---|
| `list_issues` | full rows (without `body`) | summary rows `{ref, title, status, status_key?, priority, type?, parent?, assignee?, updated, rollup?}`: no `id`, `labels`, timestamps, `links`, `customFields` or `url` | `view:"full"`, or `fields:[…]` for just what you need |
| `list_issues` | `parent` was the parent's id | `parent` is its ref (`PROJ-42`), omitted when the parent is in a project you can't see; full rows carry `parent_ref` | `verbose:true` |
| `get_issue` | `links` were raw link rows | each link is `{type, ref, title, status?}` (`list_issue_links` still returns link ids) | `verbose:true` |
| `start_work` | session, lease and claim rows | `{sessionId, leaseId, paths, issue}`, where `issue` is the claimed issue as `get_issue` returns it | `verbose:true` |
| `register_agent` | the session row | `{id, name}` | `verbose:true` |
| `claim_issue` | the lease row | `{leaseId, issueRef}` | `verbose:true` |
| `finish_work` | session and issue rows | `{sessionId, issueRef, status?, followUp?}` | `verbose:true` |
| `list_active_agents`, `list_issue_leases` | raw rows | `{id, name, issueRef?, live, startedAt, lastHeartbeatAt}`; lease rows drop `workspaceId` and `issueId` | `verbose:true` |
| `get_issue`, `get_wiki_page`, `get_playbook` | | add `version`. Pass it back as `ifVersion` and an unchanged result comes back as `{unchanged:true, version}` | omit `ifVersion` |
| `update_wiki_page`, `patch_wiki_page`, `verify_wiki_page` | `{ok, url}` | `{ok, url, revisionId}`; pass `revisionId` as the next `baseRevisionId` (`create_wiki_page` returns `revisionId: null`) | |
| `get_tool_usage` | counted from D1 | read from Workers Analytics Engine, adding `avgLatencyMs` and per-tool `errorCodes`. Returns `available:false` until the deployment configures read-back (see [Deploying](/projektor/guides/deploying/)); history recorded before the upgrade is gone | |

### Calls that now behave differently

- **`list_wiki_changes`**: `since` was required; it now defaults to seven days ago.
- **Stale agent sessions are revived.** `claim_issue`, `claim_files`, `post_message` and
  `update_issue` used to fail with "Agent session is not live" once a session's heartbeat
  expired. They now revive it, but only for the credential that registered it. Ended
  sessions still fail.
- **`start_work`** checks for a live lease conflict before registering a session, so a
  conflict no longer leaves an ended session behind.
- **Lease conflicts** name the holder: `PROJ-42 is leased by agent "x" (session …),
  claimed N min ago`, with `details {holder, issueRef, leaseAgeMinutes}`. Pick another
  issue rather than retrying.
- **Wiki conflicts** that carry a diff name the revision to retry from, as
  `baseRevisionId=<currentRevisionId>`.
- **`create_issue`** straight into `in_progress`, `in_review` or `done` stamps the same
  flow timestamps as an update, so those issues now count in `completedAfter` filters and
  flow metrics. With `agentSessionId`, creating into `in_review` or `done` needs a
  `completionReport`, as `update_issue` does.
- **`update_issue`** rejects:
  - a `comment` with nothing else to change (use `add_comment`);
  - `body` together with `appendBody` or `bodyEdits`;
  - a `bodyEdits` `find` that matches no text or more than once, in which case nothing
    in the call is written;
  - a resulting body over 50,000 characters.

  A body edit that races another change to the body returns a conflict instead of
  overwriting it.

### New

- **Tools:**
  - `create_issues`: up to 50 issues in one call, with a per-item error for an item
    that was rejected;
  - `create_issue_links`: up to 100 links, also with per-item errors.
- **`create_issue`** takes `agentSessionId`, `completionReport`, `comment` and
  `links:[{type, target}]`, all committed together.
- **`update_issue`** takes `comment`, `appendBody` and `bodyEdits:[{find, replace}]`.
- **`get_prioritized_issues`** takes `bodyChars` (0–1000) for a body preview.
- **`list_wiki_pages`** takes `sort` (`title` or `updated`) and `limit` (1–500).
- **`get_project`** accepts a project's URL slug as well as its id.
- **`get_flow_metrics`** takes `agingWipLimit` (1–50, default 10) and `verbose`.

See [Response conventions](/projektor/agents/response-conventions/) for `view`,
`fields` and `verbose`.
