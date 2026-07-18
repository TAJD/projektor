# Feedback Bulk Triage — Design

**Epic:** PROJ-398 (theme 3 of 5: bulk triage)

## Problem

`FeedbackList.tsx` only supports per-row "Mark reviewed" and "Convert to issue" actions. Triaging feedback one row at a time doesn't scale once a project accumulates more than a handful of items.

## Scope

Add multi-select to the feedback table with two bulk actions: bulk mark-reviewed and bulk convert-to-issue. Both operate on the currently-loaded (i.e. currently filtered) rows only — the table is unpaginated, so "select all" already means "all rows matching the current filter."

## API

Two new endpoints on `authedRouter`, alongside the existing per-row ones in `apps/api/src/routes/feedback.ts`:

- `POST /:id/feedback/bulk-mark-reviewed` — body `{ feedbackIds: string[] }`
- `POST /:id/feedback/bulk-convert-to-issue` — body `{ feedbackIds: string[] }`

Both require the same auth as their per-row counterparts: `requireProjectInWorkspace` + `requireProjectAccess` + `canWriteProject` (member+, viewers rejected with 403).

### `bulkMarkReviewed(ctx, { projectId, feedbackIds })`

Single statement: `UPDATE feedback SET status = 'reviewed' WHERE id IN (...) AND project_id = ? AND workspace_id = ?`. Idempotent — rows already `reviewed` or `actioned` are left as `reviewed`/unchanged by the same statement, mirroring the per-row PATCH which has no such guard today. Returns `{ updated: number }` (the D1 `meta.changes` count).

### `bulkConvertToIssue(ctx, { projectId, feedbackIds })`

1. Fetch all matching rows: `SELECT id, rating, rating_scale, body, submitter_label, linked_issue_id FROM feedback WHERE id IN (...) AND project_id = ? AND workspace_id = ?`.
2. If the returned row count doesn't match `feedbackIds.length`, throw `NotFoundError` (a ref doesn't belong to this project/workspace).
3. If **any** row has `linked_issue_id` set, throw `ConflictError` — reject the whole batch, no partial conversion. This mirrors the existing single-row re-conversion guard, extended to all-or-nothing across the batch.
4. Build one combined issue:
   - Title: `"${N} feedback items"` (N = `feedbackIds.length`).
   - Body: each row rendered as a numbered section reusing the existing per-row format — `ratingLabel()` + body + submitter footer — joined with blank lines. Example for one entry:
     ```
     1. 👍 Positive
     Great onboarding
     — submitted via feedback source by a@b.com
     ```
5. Create the issue via the existing `createIssue(ctx, { projectId, title, body, priority: "medium" })`.
6. `UPDATE feedback SET linked_issue_id = ?, status = 'actioned' WHERE id IN (...) AND workspace_id = ?` for all N rows.
7. Return `{ id: issue.id, number: issue.number, convertedCount: N }`.

Steps 1–6 are not wrapped in a D1 transaction (the codebase doesn't use them elsewhere in this file) — acceptable because step 3's all-or-nothing check happens before any mutation, so the only failure window is between issue creation and the row UPDATE, which would leave an orphan issue but no inconsistent feedback state; this matches the risk profile already accepted by the single-row path.

## UI (`apps/web/src/islands/FeedbackList.tsx`)

- New `selected: Set<string>` state.
- New checkbox column: header checkbox selects/clears all rows currently in `rows` (i.e. all rows matching the active filter); per-row checkbox toggles that row.
- Changing `status` or `sourceFilter` clears `selected` (avoids acting on rows no longer visible).
- When `selected.size > 0`, a bulk-action bar renders above the table: `"${N} selected"` plus "Mark reviewed" and "Convert to issue" buttons.
  - Bulk mark reviewed → `POST bulk-mark-reviewed` with `{ feedbackIds: [...selected] }`, then `fetchRows()` and clear `selected`.
  - Bulk convert to issue → `POST bulk-convert-to-issue` with `{ feedbackIds: [...selected] }`, then `fetchRows()` and clear `selected` on success; on 409, surface the existing `error` state (`"One or more selected items are already linked to an issue"` — reuse the existing `role="alert"` error paragraph, no new UI needed) and leave the selection intact so the user can deselect the offending row(s).
- Per-row buttons are unchanged — this is additive.

## Testing

- **Service tests** (`apps/api/src/test/feedback-bulk.test.ts`, new file, following the existing `feedback-summary.test.ts` pattern): bulk-mark-reviewed across mixed-status rows; bulk-convert building the combined issue body and linking all rows; 409 when any selected row is already converted (and confirm no issue was created / no rows mutated); cross-project id scoping (a `feedbackId` from another project is rejected).
- **Route tests**: viewer gets 403 on both new endpoints (mirrors the existing per-row route test pattern).
- **Component test** (`FeedbackList.test.tsx`, extend existing file): select-all + bulk mark-reviewed POSTs the right ids and refetches; bulk convert-to-issue POSTs and refetches; 409 renders the error alert and preserves selection.
