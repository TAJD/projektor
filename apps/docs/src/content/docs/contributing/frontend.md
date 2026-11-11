---
title: "Frontend: project identity"
description: "How the web app's islands share the current project through a module-level signals store."
sidebar:
  order: 3
---
> Reference detail moved out of [`AGENTS.md`](https://github.com/TAJD/projektor/blob/main/AGENTS.md), which keeps only the rules every change must follow.

The store lives in `apps/web/src/lib/project-context.ts`.

Islands are separate `client:load` roots (each its own Preact tree), so Preact context can't
cross between them. Project identity instead lives in a module-level `@preact/signals` store:
`currentProject`, `projectsList`, `projectError`, `projectReady`. Module state survives Astro's
`ClientRouter` navigations, so whichever island resolves first writes it and every sibling
island, plus the next in-app navigation, reads it without a refetch.

Islands call `ensureProjectResolved(workspaceSlug, urlHint?, matches?)` (or the `useCurrentProject`
hook) instead of parsing `?projectId=`/`?id=` or fetching `/api/projects` themselves. Resolution
persists the resolved id back to the address bar via `history.replaceState` (see
`resolve-project-id.ts`'s `persistProjectId`), so copied URLs stay shareable. This is the only
`@preact/signals` usage in the codebase and the only module-level store pattern for cross-island
state — reach for it, don't invent a second one, before adding a new island that needs project
identity.

The identity param is a boundary concern, not a transport mechanism: links between pages that
stay within the resolved project (`ProjectNav`'s tabs, in-app links to a project's own issues,
wiki pages, etc.) carry no project param at all — the store survives the `ClientRouter`
navigation those `<a>` tags trigger, so the destination resolves instantly with no refetch.
`?projectId=` (the project UUID) is written only where identity actually crosses a boundary: the
cold-start entry point (`ProjectList`'s project cards), a full non-SPA reload
(`window.location.href` assignments, which drop all in-memory state), or an explicit project
switch. `?id=` is reserved for a page's own entity (an issue on `/issues/view`, for example) and
is never used for project identity in newly-written links — the resolver still accepts it (along
with `?project=`) on read, for backward compatibility with existing shared URLs.

## Active tab

`ProjectNav` marks the tab whose path matches `window.location.pathname`, ignoring a
trailing slash: a deployed instance serves each page at `/issues/`, the dev server at
`/issues`.
