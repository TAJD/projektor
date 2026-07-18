# Feedback Structured Context Surfacing — Design

**Epic:** PROJ-398 (theme 2 of 5: structured context surfacing)

## Problem

`sourceUrl` already carries per-submission context as a query string (e.g. ironvolume's generator config: seed/focus/time/equipment, encoded via its `ShareSpec.buildLink()` permalink), but the admin page doesn't render it at all today — `FeedbackList.tsx` receives `sourceUrl` in its `Feedback` interface but never displays it.

## Scope

Surface `sourceUrl`'s query-string params generically in the feedback table, without projektor's core schema needing to know what any given consumer's fields mean. No backend or schema changes — `sourceUrl` is already stored and returned by `GET /:id/feedback`.

## Design

Pure client-side change to `apps/web/src/islands/FeedbackList.tsx`:

- A row with a non-null `sourceUrl` gets a `"Context (N)"` toggle button rendered under the existing body/submitter block (same place `submitterLabel` renders today), where `N` is the parsed query-param count (0 if the URL has no query string — the toggle still renders so the raw link stays reachable).
- Clicking the toggle expands to show:
  1. A link to the raw `sourceUrl` (`target="_blank" rel="noopener noreferrer"`).
  2. Each query param as a `key: value` row, parsed via `new URL(sourceUrl).searchParams`.
- Toggle state: `expanded: Set<string>` of row ids, mirroring the existing `selected` (bulk-triage) pattern — a `toggleExpanded(id)` function analogous to `toggleRow`.
- Malformed `sourceUrl` (fails `new URL(...)`, e.g. a relative path or garbage string): caught, the row renders no toggle at all rather than crashing the table. This is a per-row `try { new URL(r.sourceUrl) } catch { return null }` guard evaluated once per row during render.
- No new endpoint, no new DB column, no per-source config. Projektor never interprets what `seed`/`focus`/`time`/`equipment` (or any other consumer's param names) mean — it just parses and displays whatever key/value pairs are present. This satisfies the epic's "generic-first" requirement: the URL itself is the declaration.

## Testing

Extend `apps/web/src/islands/FeedbackList.test.tsx`:
- A row with a `sourceUrl` containing query params renders a `"Context (2)"`-style toggle; clicking it reveals the raw-URL link and each `key: value` pair.
- A row with a `sourceUrl` that has no query string still renders a `"Context (0)"` toggle; expanding it shows only the raw-URL link.
- A row with `sourceUrl: null` renders no toggle.
- A row with a malformed `sourceUrl` (e.g. `"not a url"`) renders no toggle and doesn't throw.
