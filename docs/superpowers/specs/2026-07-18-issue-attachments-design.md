# Attach items to issues

## Context

Projektor issues currently support two attachment-like mechanisms that already ship: uploaded **file attachments** (`packages/db/src/schema/attachments.ts`, `apps/api/src/routes/files.ts`, surfaced in `apps/web/src/islands/IssueDetail.tsx`, with backend coverage in `apps/api/src/test/files.test.ts`) and **issue-to-issue links** (`issue_links` table, `create_issue_link` MCP tool). Neither has been checked recently against the request "let people attach items to issues" without first confirming what exists — this spec is the result of that check.

Two gaps remain:
1. File attachments have zero Playwright (e2e) coverage — only backend integration tests.
2. There is no way to attach a **reference** to a wiki page or an **external URL** to an issue. (Uploading a wiki page as a *file* is technically possible via the existing `entityType: wiki_page` attachment, but that's unrelated — it attaches a file to a wiki page, not a wiki-page link to an issue.)

## Scope

One epic, three sub-tickets, filed under project **PROJ** (Projektor), workspace `ws-projektor`.

### 1. E2E coverage: file attachments (no new product code)

The feature already works. This ticket adds Playwright coverage only.

**Acceptance criteria** (documents existing behavior the e2e suite must verify):
1. From an issue detail page, a user can click "Attach file", choose a file, and upload it — it appears in the Attachments list with filename + size.
2. Clicking an attachment's filename opens/downloads it (image types render inline, other types download).
3. A user can delete an attachment via its remove control; it disappears from the list immediately.
4. Uploading a disallowed file type or an oversized file shows an inline error (`role="alert"`) and does not add a list entry.
5. Attachments are scoped to the issue — switching to a different issue shows a different, non-overlapping attachment list.

**Playwright test plan** (`apps/web/e2e/issue-attachments.spec.ts`, following `wiki-flow.spec.ts` conventions — `E2E_BASE_URL`-gated, reads `.e2e-ctx.json`):
1. Happy path: open an issue → attach a file → assert it appears with correct filename/size → reload the page → assert it persists → delete it → assert it's gone.
2. Reject path: attempt to upload a disallowed file type → assert inline error, no list entry added.
3. Isolation: attach a file to issue A, open issue B, assert A's attachment is not visible on B.

### 2. Attach a wiki page reference to an issue

**Acceptance criteria:**
1. From the issue's Attachments panel, a user can search/pick a wiki page from the workspace and attach it as a reference (no file upload involved).
2. The reference appears in the same Attachments list as files, with a distinguishing icon and the wiki page's title.
3. Clicking the reference navigates to the wiki page.
4. Any workspace member can remove the reference from the issue; it disappears immediately and does not delete the underlying wiki page.
5. References are scoped per-issue, same as file attachments.

**Playwright test plan** (extends `issue-attachments.spec.ts` or a sibling file):
1. Attach a wiki page → assert list entry with correct title → click through to the wiki page → navigate back → assert entry still present.
2. Remove the reference → assert it's gone from the list and the wiki page itself still exists (unaffected).

### 3. Attach an external URL to an issue

**Acceptance criteria:**
1. From the issue's Attachments panel, a user can add an external URL with an optional label.
2. The entry appears in the Attachments list showing the label if provided, otherwise the URL itself; opens in a new tab (`target="_blank"`).
3. Submitting a malformed URL (not `http://`/`https://`) shows an inline error and does not add an entry.
4. Any workspace member can remove the URL entry; it disappears immediately.
5. URL attachments are scoped per-issue, same as file attachments.

**Playwright test plan:**
1. Add a URL with a label → assert entry shows the label and links to the correct `target="_blank"` URL.
2. Add a URL without a label → assert the URL itself is shown as the entry text.
3. Remove an entry → assert it's gone.
4. Submit a malformed URL → assert inline error, no entry added.

## Data model note

Sub-tickets 2 and 3 extend the existing unified Attachments panel rather than introducing separate UI sections. This likely means extending `attachments.entityType`/adding a `kind` discriminator (`file | wiki_ref | url`) so all three render from one list, keyed by `(workspaceId, entityType, entityId)` as today. The exact schema shape (new column vs. new table) is left to the implementation plan for each sub-ticket, not fixed here.

## Permissions

Any workspace member can add or remove any attachment kind on an issue they can view — consistent with projektor's existing collaborative model (matches commenting).

## Out of scope

- Issue-to-issue linking as an "attachment" — already covered by the existing `issue_links` feature; not duplicated here.
- Versioning/history of attachments (e.g. re-uploading a file to replace one) — not requested.
- Per-file or per-attachment-kind granular permissions beyond "any workspace member" — not requested.
