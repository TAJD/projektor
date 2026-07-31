-- 0047: R9 (PROJ-491) — seed built-in wiki templates (runbook, adr, spec) for every
-- existing workspace, under a workspace-level "Templates" parent page (PRD: "conventionally
-- living in a Templates space/parent"). Mirrors 0016_seed_missing_task_types.sql's
-- per-workspace idempotent backfill pattern (INSERT guarded by NOT EXISTS per slug, safe
-- to re-run). New workspaces get the same three pages from
-- services/wiki.ts#seedDefaultWikiTemplates (called by createWorkspace) — kept in sync by
-- hand, same as seedDefaultTaskTypes/0016 already are for task types.
--
-- wiki_pages.created_by_id/updated_by_id are NOT NULL FKs to users, and a data migration
-- has no request-scoped actor to attribute the write to — authored as the workspace's
-- owner (MIN(user_id) picks a single deterministic owner if more than one row has that
-- role). A workspace with no owner row is skipped rather than guessed at.
INSERT INTO wiki_pages (
	id, workspace_id, project_id, slug, title, content, parent_id,
	created_by_id, updated_by_id, created_at, updated_at,
	type, tags, status, verified_at, verified_by, owners, verify_interval, is_template
)
SELECT
	lower(hex(randomblob(16))), w.id, NULL, 'templates', 'Templates', '', NULL,
	owner.user_id, owner.user_id, strftime('%s', 'now'), strftime('%s', 'now'),
	NULL, '[]', NULL, NULL, NULL, '[]', NULL, 0
FROM workspaces w
JOIN (
	SELECT workspace_id, MIN(user_id) AS user_id
	FROM workspace_members
	WHERE role = 'owner'
	GROUP BY workspace_id
) owner ON owner.workspace_id = w.id
WHERE NOT EXISTS (SELECT 1 FROM wiki_pages WHERE workspace_id = w.id AND slug = 'templates');

INSERT INTO wiki_pages (
	id, workspace_id, project_id, slug, title, content, parent_id,
	created_by_id, updated_by_id, created_at, updated_at,
	type, tags, status, verified_at, verified_by, owners, verify_interval, is_template
)
SELECT
	lower(hex(randomblob(16))), w.id, NULL, 'templates-runbook', 'Runbook Template',
'---
type: runbook
status: draft
template: true
---
# Runbook: [Title]

## Purpose

What this runbook is for and when to use it.

## Preconditions

-

## Steps

1.
2.
3.

## Rollback

## Verification
',
	parent.id, owner.user_id, owner.user_id, strftime('%s', 'now'), strftime('%s', 'now'),
	'runbook', '[]', 'draft', NULL, NULL, '[]', NULL, 1
FROM workspaces w
JOIN (
	SELECT workspace_id, MIN(user_id) AS user_id
	FROM workspace_members
	WHERE role = 'owner'
	GROUP BY workspace_id
) owner ON owner.workspace_id = w.id
JOIN wiki_pages parent ON parent.workspace_id = w.id AND parent.slug = 'templates'
WHERE NOT EXISTS (
	SELECT 1 FROM wiki_pages WHERE workspace_id = w.id AND slug = 'templates-runbook'
);

INSERT INTO wiki_pages (
	id, workspace_id, project_id, slug, title, content, parent_id,
	created_by_id, updated_by_id, created_at, updated_at,
	type, tags, status, verified_at, verified_by, owners, verify_interval, is_template
)
SELECT
	lower(hex(randomblob(16))), w.id, NULL, 'templates-adr', 'ADR Template',
'---
type: adr
status: draft
template: true
---
# ADR NNNN: [Title]

## Status

Proposed

## Context

## Decision

## Consequences
',
	parent.id, owner.user_id, owner.user_id, strftime('%s', 'now'), strftime('%s', 'now'),
	'adr', '[]', 'draft', NULL, NULL, '[]', NULL, 1
FROM workspaces w
JOIN (
	SELECT workspace_id, MIN(user_id) AS user_id
	FROM workspace_members
	WHERE role = 'owner'
	GROUP BY workspace_id
) owner ON owner.workspace_id = w.id
JOIN wiki_pages parent ON parent.workspace_id = w.id AND parent.slug = 'templates'
WHERE NOT EXISTS (
	SELECT 1 FROM wiki_pages WHERE workspace_id = w.id AND slug = 'templates-adr'
);

INSERT INTO wiki_pages (
	id, workspace_id, project_id, slug, title, content, parent_id,
	created_by_id, updated_by_id, created_at, updated_at,
	type, tags, status, verified_at, verified_by, owners, verify_interval, is_template
)
SELECT
	lower(hex(randomblob(16))), w.id, NULL, 'templates-spec', 'Spec Template',
'---
type: spec
status: draft
template: true
---
# [Feature] Spec

## Problem

## Goals

## Non-goals

## Design

## Open questions
',
	parent.id, owner.user_id, owner.user_id, strftime('%s', 'now'), strftime('%s', 'now'),
	'spec', '[]', 'draft', NULL, NULL, '[]', NULL, 1
FROM workspaces w
JOIN (
	SELECT workspace_id, MIN(user_id) AS user_id
	FROM workspace_members
	WHERE role = 'owner'
	GROUP BY workspace_id
) owner ON owner.workspace_id = w.id
JOIN wiki_pages parent ON parent.workspace_id = w.id AND parent.slug = 'templates'
WHERE NOT EXISTS (
	SELECT 1 FROM wiki_pages WHERE workspace_id = w.id AND slug = 'templates-spec'
);
