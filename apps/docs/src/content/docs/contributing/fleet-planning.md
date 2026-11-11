---
title: "Planning a fleet of workers"
description: "Rules for whoever splits work across parallel agents in this repo: file ownership, serialized files, spawn prompts and merge order."
sidebar:
  order: 5
---
> Reference detail moved out of [`AGENTS.md`](https://github.com/TAJD/projektor/blob/main/AGENTS.md), which keeps only the rules every change must follow.

This page is for the session that plans and spawns parallel workers. A worker only needs
the call sequence in `AGENTS.md` ("Fleet coordination protocol").

## Working in parallel

This repo is built out via parallel workers in separate git worktrees. To avoid conflicts:
- Give each worker a **disjoint file set** (one domain = the files named after it, see "File layout per domain" in `AGENTS.md`). Domains don't share files *except* read-only shared scaffolding (`services/types.ts`, `services/errors.ts`, `schemas/common.ts`, the adapters) and `routes/mcp.ts`/`index.ts`.
- **Never let two parallel workers edit `routes/mcp.ts`, `index.ts`, or `test/mcp.test.ts`** — serialize those, or assign to exactly one worker.
- Large refactors that touch shared files go in a **foundation phase first** (behavior-preserving), then fan out per-domain.

## Spawn prompt requirement

Workers will not use the coordination primitives unless explicitly told to. Every spawn prompt for a parallel worker **must** include a `## Coordination (required)` section stating the call sequence from "Fleet coordination protocol" in `AGENTS.md`. Default to the two-call `start_work`/`finish_work` path and tell workers not to call `heartbeat_agent`, `register_agent` or `release_*` separately; use the five-call path only when a task needs finer-grained control.

A full spawn prompt also needs a **Finish** section (what "done" means for the task,
and what to report back) alongside the Coordination section.

## Fleet planning rules

These are the constraints to plan batches by. Keep them current when the codebase changes.

**Serialized files** — only one worker at a time, ever:

| File | Reason |
|------|--------|
| `apps/api/src/routes/mcp.ts` | MCP tool registry — all domains compose here |
| `apps/api/src/index.ts` | Hono app root — route mounting |
| `apps/api/src/test/mcp.test.ts` | Cross-cutting dispatch tests — domain tests go in `test/<domain>.test.ts` |

**Domain → file ownership** — one agent per domain, no overlap. A domain owns the files named after it in
`services/`, `schemas/`, `operations/`, `routes/`, `mcp/` and `test/` (see "File layout per domain").

Frontend islands are **not** domain-locked in the same way, but two agents must never
own the same island file. Assign each island to exactly one agent per batch.

**CI commands:** see **Before opening a PR** under "Dev workflow" in `AGENTS.md`.

**Merge ordering rule:** if two agents both touch the same frontend file (e.g.
`IssueList.tsx`), assign one as "primary" and one as "secondary". Primary merges
first; secondary rebases onto main before merging. Document this in the spawn prompts
and in the fleet manifest.

## The five-call path

`start_work` and `finish_work` compose from these primitives, which remain available for
finer-grained control (for example claiming files separately from the issue, or checking
`list_file_claims` before deciding whether to `force`):

1. `register_agent` at session start, linking the issue you're implementing — save the returned `id`.
2. `claim_files` before touching any file (check `list_file_claims` first; back off, don't `force`).
3. `post_message` to `scope: "issue:<uuid>"` when you start/blocker/finish; `scope: "workspace"` for fleet-wide notices.
4. `heartbeat_agent` if about a minute passes without a session-scoped call (a session goes stale after 120 seconds).
5. `release_files` then `end_agent` when done.

See the [MCP tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) for each tool's exact input schema.
