# Direct user feedback ingestion (PROJ-378)

Status: design-only. No implementation lands with this doc; see Follow-up
implementation tickets below.

## Motivation

projektor closes the loop from planning to code (issues, wiki, sprints) and from code
back to planning (flow metrics, code heatmap), but nothing closes the loop from
**shipped software back to the people using it**. Today the only way a real end-user
observation reaches a project is a human manually filing an issue on their behalf.
This ticket adds a direct ingestion path: a lightweight, publicly embeddable submit
endpoint that lets an end-user (or their app, on their behalf) post a rating and/or a
free-text comment straight against a specific projektor project, and a triage view
that turns raw feedback into issues without leaving projektor.

**Scope for v1** is direct end-user (browser) submission — a marketing site or app
calling the submit endpoint from client-side JS with a publishable token scoped to a
specific **feedback source**. A server-to-server caller (a backend relaying feedback
it collected elsewhere) is not a separate design: a source minted with no
`allowedOrigins` restriction behaves like a plain bearer credential and works today
with zero extra work. It's called out here as a natural fast-follow, not an open
question.

## The feedback source concept

A **feedback source** is a named, configurable collection point that a workspace
admin/owner sets up ahead of time — e.g. "Onboarding survey", "In-app NPS widget",
"Post-checkout survey". The admin creates the source in projektor, then builds a
form/widget in *their own* product that submits against that specific source. Each
source is an independent, first-class object with its own name, description, and
lifecycle.

**One token per source, not one token per project.** Each source carries exactly one
active credential (its current token). Because credentials are per-source, revoking
or rotating one source's integration never touches any other source — a compromised
in-app widget can be killed without disturbing the onboarding survey that shares the
same project. This is the key shape change from earlier drafts, which modelled a
single project-level token.

A source has two distinct lifecycle controls that are deliberately *not* the same
thing:

- **Rotation** swaps the credential while keeping the source alive — same `id`, same
  name/description, same historical feedback. Used when a token leaks or needs
  periodic rotation.
- **Revocation** kills the source permanently (`revoked_at` stamp). The source's
  history is retained for traceability, but it can never accept another submission;
  replacing a revoked source means creating a brand-new one.

There is also an **`is_active` kill switch** (see below), a reversible pause that is
distinct from both.

## The core decision: the source's current token is the trust boundary, not CF Access

### Why CF Access can't gate this route

The whole projektor hostname currently sits behind a Cloudflare Zero Trust Access
Application at the edge — separate from, and in front of, this app's own
`middleware/auth.ts`. Access terminates unauthenticated requests before they ever
reach the Worker. That's the point of it for every other route, and it's a hard
blocker here: an anonymous end-user's browser has no way to clear an Access login
flow before firing a feedback POST, so **nothing reaches `POST /api/feedback/submit`
at all** under the current edge config, regardless of what this codebase does.

**Resolution — infrastructure prerequisite, not application work (see "Deployment
blocker" below):** `POST /api/feedback/submit` must be excluded from the Access
Application, via a path-scoped bypass policy (or a second Access Application scoped
to just this path) configured in `projektor-workspace`. This is not something a PR
against this repo can do.

### Why Access Service Tokens were rejected

Cloudflare Access Service Tokens (a client-id/client-secret pair that satisfies an
Access policy programmatically) were considered and rejected for this specific route.
A Service Token secret shipped in browser JS is visible to anyone who opens dev
tools — it stops being a secret the moment it's used from a client-side submit
button. Mixing Service-Token auth with a public-browser caller doesn't work; the
Access layer's whole model assumes the credential stays server-side.

### The resolution: the source's current token is the trust boundary

Once the path is excluded from Access, `POST /api/feedback/submit` authenticates
itself: it verifies the presented bearer credential against a `feedback_sources` row
inline, the same pattern `services/share.ts` already uses for share-token redemption
(`getSharedIssue`) — hash lookup against the table, no `ServiceCtx`, no user, no
role, not routed through `middleware/auth.ts` at all.

This is a deliberate design point, not a compromise: **a source's token is meant to
be public**, in exactly the sense a Sentry DSN, a PostHog project API key, or a
Stripe *publishable* key are public. It ships in client-side JS by design. The
security posture is "limit blast radius if it leaks," not "keep it secret":

- **Write-only.** The submit route has no read capability at all — it can insert a
  `feedback` row and return `{ id }`. It cannot list, read, or enumerate anything
  else in the project, so a leaked token can't be used to exfiltrate data.
- **Single-source scoped.** A token resolves to exactly one source, and from that
  source to exactly one `project_id`/`workspace_id`, looked up directly from the
  source row — never taken from request input.
- **Cheaply revocable *and* rotatable.** Revocation is a soft `revoked_at` stamp (see
  Schema below), checked on every submit; rotation replaces `token_hash` in place. An
  admin can kill or rotate a leaked/abused source's credential in one call with no
  downstream cleanup — and, crucially, without losing the source's identity or
  history, because the source's `id` is separate from its `token_hash`.
- **Rate-limited and origin-restricted** as the v1 abuse controls (below) — the two
  things a per-token secret can't provide on its own once it's public.

### v1 abuse controls

Two controls, both reusing existing primitives:

1. **Per-source rate limiting**, via `bumpRateCounter` (`middleware/rate-limit.ts`),
   the same primitive already used for the auth-failure throttle
   (`tooManyAuthFailures` in `middleware/auth.ts`) and other per-token limiting.
   Recommend **dual-keying**, mirroring `tooManyAuthFailures`'s
   `authfail:${ip}` pattern: bump both `feedback:${tokenHash}` and
   `feedback-ip:${ip}` (from `CF-Connecting-IP`), and reject if either trips its
   limit. Token-only keying alone would let an attacker who doesn't have a token
   spam a nonexistent-token lookup from one IP without ever hitting a per-token
   bucket; IP-only keying alone would let a legitimate high-traffic site's shared
   egress IP get throttled unfairly. Dual-keying, same rationale as the existing
   auth-failure throttle, covers both.
2. **Per-source CORS allow-list** (`allowed_origins`, see Schema) — a source minted
   with an explicit origin list only returns `Access-Control-Allow-Origin` for a
   matching `Origin` header (including `OPTIONS` preflight handling); a source minted
   with `allowedOrigins: null` returns no CORS header at all (the server-to-server
   case — no browser is expected to call it directly, so there's nothing to allow).
   This is **separate from, and does not go through,** the global `cors()`
   middleware/`CORS_ALLOWED_ORIGINS` allowlist in `index.ts` — that middleware
   protects the authenticated app surface for the projektor SPA's own origin; a
   third-party site embedding a feedback source's token is never going to be in that
   list, by design.

**Cloudflare Turnstile** (bot-check challenge) was discussed and explicitly deferred
for v1 — see "Out of scope" below.

## Data model

Two new tables, workspace + project scoped like the rest of the schema. Migration
number is illustrative (`00XX`) — the actual next-available number depends on what
else has landed in `packages/db/migrations/` by implementation time.

```sql
-- packages/db/migrations/00XX_feedback.sql

CREATE TABLE feedback_sources (
	id TEXT PRIMARY KEY,                 -- crypto.randomUUID() — stable identity, independent of the current token
	token_hash TEXT NOT NULL UNIQUE,     -- sha256(raw token), never the raw token — this is what submit looks up. Separate from id so rotation keeps the source's identity/history (see share_tokens/api_tokens for the hash pattern)
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL,                  -- required, e.g. "Onboarding survey"
	description TEXT,                     -- optional human note
	is_active INTEGER NOT NULL DEFAULT 1, -- hard kill switch; 0 = submissions rejected with 403
	allowed_origins TEXT,                -- JSON array of origin strings, or NULL = no CORS restriction (server-to-server)
	created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER                   -- soft revoke (nullable) — source permanently dead; history kept for traceable origin
);
CREATE INDEX idx_feedback_sources_project ON feedback_sources(project_id);

CREATE TABLE feedback (
	id TEXT PRIMARY KEY,                 -- crypto.randomUUID()
	source_id TEXT NOT NULL REFERENCES feedback_sources(id) ON DELETE CASCADE, -- the row's real parent; feedback groups/filters by source in triage
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,    -- denormalized for the always-scope-by-workspace invariant
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,        -- denormalized for query convenience/scoping
	rating INTEGER,                      -- e.g. -1/1 for thumbs, 1-5 for five_star; NULL if no rating given
	rating_scale TEXT,                   -- "thumbs" | "five_star"; NULL iff rating IS NULL
	body TEXT,                           -- free-text comment
	submitter_label TEXT,                -- caller-supplied identifier string (email, app-user-id, ...) — see below
	source_url TEXT,
	app_version TEXT,
	status TEXT NOT NULL DEFAULT 'new',  -- "new" | "reviewed" | "actioned"
	linked_issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_source_status ON feedback(source_id, status);
CREATE INDEX idx_feedback_project_status ON feedback(project_id, status);
```

`token_hash` is a separate column from `id` **on purpose**: `id` is the source's
stable identity (referenced by every `feedback.source_id`), while `token_hash` is the
rotatable credential. Rotation overwrites `token_hash` and leaves `id` — and
therefore every historical feedback row's parent link — untouched. This is the whole
reason the two are not collapsed into one column the way the earlier project-token
draft did (it stored `sha256(token)` *as* the primary key, which would have made the
source's identity die with its credential on every rotation).

`source_id` is the row's real parent — feedback is grouped and filterable by source
in triage, not just by project. `workspace_id`/`project_id` are still denormalized
onto the row so every query can be scoped directly by `workspace_id` per `AGENTS.md`'s
"always scope by workspace" security invariant, and so triage can filter by project
without a join.

`rating`/`body` at-least-one-of validation and `rating`/`rating_scale` co-presence are
both enforced in the Zod schema (`schemas/feedback.ts`), not a DB `CHECK` constraint —
this repo's existing convention for "at least one of" rules. The closest precedent is
`UpdatePageSchema` in `apps/api/src/schemas/wiki.ts`:

```ts
export const UpdatePageSchema = z
	.object({ title: z.string().min(1).max(300).optional(), content: z.string().max(500000).optional(), parentId: z.string().uuid().nullable().optional() })
	.refine((d) => d.title !== undefined || d.content !== undefined || d.parentId !== undefined, {
		message: "At least one of title, content, or parentId must be provided",
	});
```

`schemas/feedback.ts`'s `SubmitFeedbackSchema` follows the same shape:
`.refine((d) => d.rating !== undefined || d.body !== undefined, { message: "At least one of rating or body must be provided" })`,
plus a second `.refine` requiring `ratingScale` whenever `rating` is present (and
forbidding it otherwise).

### `submitter_label` is not an identity

`submitter_label` is a plain, caller-supplied string — an email address, an
app-internal user id, whatever the embedding site chooses to send — stored verbatim
with **no** foreign key to `users`, and it never touches `services/provisioning.ts`.
This is a deliberate contrast with PROJ-373's public read-only viewer, which *does*
provision a real `users` row (the shared `public-viewer@projektor.local` identity) so
anonymous read traffic has something to attribute to in existing role/audit checks.
Feedback submission has no such need — there's no role to check, no audit trail that
joins against `users`, and provisioning a user per arbitrary caller-supplied string
would be both wrong (it's not an authenticated identity, callers can put anything in
it) and a growth problem (unbounded `users` rows keyed off untrusted input). It is
metadata for a human triaging feedback to read, nothing more.

## API surface

Source **management** has full REST + MCP parity; the public **submit** endpoint is
REST-only by necessity — see "REST↔MCP parity exception" below.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/projects/:id/feedback-sources` | admin/owner only | Create a source. Body: `{ name, description?, allowedOrigins?: string[] }`. Returns `{ id, token }` — raw token shown once. |
| `GET /api/projects/:id/feedback-sources` | admin/owner only | List sources: `id`, `name`, `description`, `isActive`, hash-truncated current token, `allowedOrigins`, `createdAt`, `revokedAt`. Never the raw token. |
| `PATCH /api/projects/:id/feedback-sources/:sourceId` | admin/owner only | Body: `{ name?, description?, isActive? }`. `isActive: false` is a hard kill switch (see below). |
| `POST /api/projects/:id/feedback-sources/:sourceId/rotate` | admin/owner only | Generates a new raw token, updates `token_hash` to its hash, returns `{ token }` once. Old token stops working immediately; `id`/`name`/`description`/history untouched. |
| `DELETE /api/projects/:id/feedback-sources/:sourceId` | admin/owner only | Sets `revoked_at` — permanent. (Contrast with `isActive: false`, a reversible pause.) |
| `POST /api/feedback/submit` | feedback source token (own verification, excluded from CF Access) | Body: `{ rating?, ratingScale?, body?, submitterLabel?, sourceUrl?, appVersion? }`. Returns `{ id }` only. |
| `GET /api/projects/:id/feedback` | any project role with read visibility | `?status=` and `?sourceId=` filters. |
| `PATCH /api/projects/:id/feedback/:feedbackId` | member+ (not viewer) | Body: `{ status? }`. |
| `POST /api/projects/:id/feedback/:feedbackId/convert-to-issue` | member+ | Reuses `createIssue`; sets `linked_issue_id` + `status: "actioned"`. |

### Source management routes — admin/owner only, tighter than share-token guard

`createShareToken` gates on `ctx.role === "viewer"` (blocks viewers, allows
member/admin/owner) because it mints a read-share credential. Creating or mutating a
`feedback_sources` credential is a stronger operation — the resulting token can write
into the project indefinitely until revoked — so the guard on **every** source-
management route (create/list/update/rotate/revoke) is `!isWorkspaceAdmin
(effectiveRole)` (admin/owner only, `services/access.ts`), not the `viewer`-only
block share tokens use. All of them mirror `createShareToken`/`revokeShareToken`'s
workspace + resource-existence check pattern (look up the project scoped to
`ctx.workspaceId` first, 404 if not found, *then* check role — matching the existing
`NotFoundError`-before-`ForbiddenError` ordering used throughout `services/share.ts`
and `services/issues.ts`). Source-level operations (`update`/`rotate`/`revoke`) also
look up the source scoped to `ctx.workspaceId` and its project, 404 before 403.

### Rotation vs. revocation vs. the `is_active` kill switch

Three distinct lifecycle actions, deliberately kept separate:

- **`POST .../rotate`** — swaps the credential, keeps the source. Generates a fresh
  raw token, sets `token_hash = sha256(newToken)`, returns the new raw token once.
  The old token is dead the instant `token_hash` changes. The source's `id`, `name`,
  `description`, `is_active`, `allowed_origins`, and every historical `feedback` row
  (which point at `id`, not at any token) are untouched. This is the "the token
  leaked / time to rotate" path.
- **`DELETE .../:sourceId`** (revoke) — sets `revoked_at`, permanently. A revoked
  source can never accept another submission; to "replace" it you create a brand-new
  source. History is retained. This is the "this source is gone for good" path.
- **`PATCH .../:sourceId { isActive: false }`** — a reversible **hard kill switch**,
  not a visibility filter. While a source is inactive, `POST /api/feedback/submit`
  against its token returns **403** (not a silent success, not a hidden-from-lists
  no-op) — matching the mental model of an actual pause button: a source turns out to
  be spammed or misconfigured and the admin wants submissions to *stop immediately*.
  Setting `isActive: true` again resumes it with the same token. `name`/`description`
  edits go through the same `PATCH`.

### Submit-time rejection codes

| Condition | Status |
|---|---|
| No token / unknown token hash | 401 |
| Source `revoked_at IS NOT NULL` | 401 |
| Source `is_active = 0` | 403 |
| Rate limit tripped (token- or IP-keyed) | 429 |
| Body fails `SubmitFeedbackSchema` | 400 |

Revoked returns **401** (the credential is treated as no longer valid, same as an
unknown token — carried over from the earlier draft's revoked-token behaviour).
Inactive returns **403** (the credential is recognized and valid, but the source is
deliberately paused — an authorization-style refusal, not an authentication failure).
The distinction is intentional: 401 says "this token isn't a thing anymore," 403 says
"this token is a thing, but it's switched off right now."

### `POST /api/feedback/submit` — implementation shape

Mirrors `routes/share.ts`'s two-router split (`shareIssuesRouter` authenticated,
`sharePublicRouter` not) and `getSharedIssue`'s inline-verification pattern:

1. Mounted in `index.ts` **before** the `authMiddleware`/`workspaceMiddleware` wiring,
   the same way `app.route("/api/share", sharePublicRouter)` is mounted ahead of the
   authenticated block (see `index.ts:161-162`) — with a comment flagging it as public
   and CF-Access-excluded.
2. Reads `Authorization: Bearer <feedback-token>`, hashes it (same
   `sha256(token)` → `feedback_sources.token_hash` lookup share tokens use), and looks
   up the row directly by hash — no `ctxFromHono`, no `ServiceCtx`.
3. 401s if no row, or if `revoked_at IS NOT NULL`. 403s if `is_active = 0`.
4. Resolves `source_id`/`project_id`/`workspace_id` from the source row itself — never
   from request input, closing off any cross-project injection via the body.
5. Applies the per-source CORS response header (see "v1 abuse controls" above),
   including responding to `OPTIONS` preflight.
6. Rate-limits via dual-keyed `bumpRateCounter` (token hash + `CF-Connecting-IP`);
   429s over the limit.
7. Validates the body against `SubmitFeedbackSchema` (`schemas/feedback.ts`);
   400s with the Zod validation error on failure (matching how every other route
   surfaces `ValidationError` via `serviceErrToResponse`).
8. Inserts the `feedback` row (`source_id`, `project_id`, `workspace_id` all from the
   source), `status = "new"`, and returns `{ id }` — nothing else.

### `GET /api/projects/:id/feedback` — read-visibility pattern

Uses the same project-visibility check the rest of the group-based access model
(PROJ-311, `services/access.ts`) applies to project-scoped reads:
`requireProjectAccess(ctx, projectId)` to resolve the effective role (throws
`NotFoundError` → 404 if the caller has no grant on the project, hiding its
existence — the established pattern, not a 403), then list `feedback` rows filtered
by the optional `status` and `sourceId` query params. Any resolved role (`viewer`
included) can read; `viewer` cannot call the `PATCH`/convert-to-issue routes.

### `PATCH .../feedback/:feedbackId` and `.../convert-to-issue` — write guard

Both require `canWriteProject(role)` after `requireProjectAccess` — the same
`viewer`-excluded write guard already used across `issue-links.ts`, `share.ts`,
`wiki.ts`, and `comments.ts` (`ctx.role === "viewer"` / `role !== "viewer"` checks).

### `convert-to-issue` — reuses `createIssue` verbatim

Calls the existing `services/issues.ts::createIssue(ctx, raw)` — the same function
`POST /api/issues` and the MCP `create_issue` tool both call — rather than a new
issue-creation path. `raw` is built server-side from the feedback row, not
client input:

```ts
{
	projectId,                                          // the feedback's project_id
	title: feedback.body
		? feedback.body.slice(0, 120)                    // first ~120 chars as a title; no separate title field on feedback
		: `${ratingLabel(feedback.rating, feedback.ratingScale)} feedback`, // rating-only submissions
	body: [
		feedback.body ?? "",
		"",
		`— submitted via feedback source${feedback.submitterLabel ? ` by ${feedback.submitterLabel}` : ""}` +
			(feedback.rating != null ? `, rating: ${feedback.rating} (${feedback.ratingScale})` : ""),
	].join("\n"),
	priority: "medium",                                 // CreateIssueSchema default; no signal in feedback maps to priority
}
```

After `createIssue` succeeds, the service sets `feedback.linked_issue_id = issue.id`
and `feedback.status = "actioned"` in the same call, and returns the new issue (not
the feedback row) — matching the ticket's stated return shape. **Judgement call —
flagged for confirmation:** the exact title-truncation length (120 chars) and the
body-footer wording are my own reasonable defaults, not specified in the brief;
sanity-check before implementing.

## REST↔MCP parity: source management has both; submit is REST-only

This feature adds full REST + MCP parity for source **management**, and keeps the
public submit endpoint REST-only. That split is the whole point of this section.

### Management gets MCP tools

Source management (create/list/update/rotate/revoke) is an authenticated,
in-workspace, workspace-scoped action — exactly the kind of thing a workspace admin's
AI agent should be able to do conversationally ("set up a feedback source for the new
onboarding survey"). So it gets full REST + MCP parity like any other authenticated
domain in this codebase, per the default parity rule in `AGENTS.md`.

New MCP tools live in `apps/api/src/mcp/feedback.ts`, composed into `routes/mcp.ts`
per the existing per-domain pattern (follow `mcp/issue-links.ts` / `mcp/comments.ts`
for the exact tool-definition shape, JSON-schema style, and error-adapter wiring):

- **`create_feedback_source`** — `{ projectId, name, description?, allowedOrigins? }`
  → `{ id, token }`. Description should explain, for the agent's benefit, that a
  feedback source is a named collection point whose returned token must be embedded in
  the user's own product code (a form/widget) to submit feedback, and that the raw
  token is shown exactly once and cannot be retrieved later — so the agent should
  relay it to the human immediately.
- **`list_feedback_sources`** — `{ projectId }` → list of sources with the current
  token **hash-truncated for display** (never the raw token), plus `id`, `name`,
  `description`, `isActive`, `allowedOrigins`, `createdAt`, `revokedAt`.
- **`update_feedback_source`** — `{ sourceId, name?, description?, isActive? }`.
  Description should note that `isActive: false` immediately stops the source
  accepting submissions (a reversible kill switch), distinct from revoking.
- **`rotate_feedback_source_token`** — `{ sourceId }` → `{ token }`. Description should
  note the new raw token is returned once, the old token stops working immediately,
  and the source's identity/history are preserved — contrast with revoking.
- **`revoke_feedback_source`** — `{ sourceId }`. Description should note this is
  permanent (kills the source for good; create a new source to replace it).

Write these descriptions to be genuinely useful to an agent configuring things on a
user's behalf, at the level of detail `get_workflow` and the other richly-described
tools in this codebase use — the agent calling `create_feedback_source` is the one
that will have to tell a human "here's your token, paste it into your widget code."

### Submit is deliberately REST-only — the one asymmetry

`POST /api/feedback/submit` explicitly gets **no MCP tool**. This is the single
deliberate asymmetry in the feature, and the same *category* of parity exception as
the existing "Public issue sharing" entry in `AGENTS.md`'s exceptions list: the
submit endpoint is external, unauthenticated-by-session, and anonymous — it's called
by third-party browser/server code representing an anonymous end-user, and there is no
"agent" on the other end of an anonymous feedback submission to hand an MCP tool to.
An AI agent is never the party submitting anonymous end-user feedback.

Following the style of that list in `AGENTS.md` (this describes the addition; it does
**not** edit `AGENTS.md` — the entry is added there when the feature lands):

- **Public feedback submit (`POST /api/feedback/submit`, `routes/feedback.ts`)** —
  REST-only. Same rationale category as public issue sharing: an external,
  unauthenticated-by-session ingestion endpoint called by third-party browser/server
  code on behalf of an anonymous end-user, with no MCP client on the other end.
  Source *management* (`create_feedback_source`, `list_feedback_sources`,
  `update_feedback_source`, `rotate_feedback_source_token`, `revoke_feedback_source`)
  has full REST + MCP parity like any other authenticated domain — only the anonymous
  submit endpoint is the exception.

## Deployment blocker (must be raised separately)

**This is a hard prerequisite, not a nice-to-have.** The application code in this
repo can be fully built, tested, and merged, but `POST /api/feedback/submit` will not
be reachable by real external traffic — no third-party browser can hit it — until the
Cloudflare Zero Trust Access Application excludes this path. That change:

- Lives in `projektor-workspace` (the config-only deploy repo), not this repo.
- Is either a path-scoped bypass policy on the existing Access Application, or a new
  Access Application scoped to exactly `POST /api/feedback/submit` (and its `OPTIONS`
  preflight) with a "bypass" or "allow" policy — the specific mechanism is an infra
  decision for whoever owns the Zero Trust config, out of scope for this design.
- Must be raised and resolved with that owner **before** this feature is announced as
  live, even though the projektor-side PR(s) can merge and deploy independently.

## Web UI (Preact islands, `apps/web`)

Two new islands, following the existing conventions in
`apps/web/src/islands/TokenManager.tsx` and `apps/web/src/islands/ProjectNav.tsx` /
`ProjectList.tsx` exactly — no raw `fetch(`, only `apiFetch`/`buildHeaders` from
`apps/web/src/utils/api-client.ts`.

### Tab placement

`ProjectNav.tsx`'s tab set is a hardcoded module-level array
(`const TABS = [{ label, path }, ...]`: Overview, Issues, Wiki, Sprints, Epics,
Metrics), rendered via `.map` with a `switch (t.path)` deciding the href shape. Adding
Feedback is a one-line addition to that array (`{ label: "Feedback", path:
"/feedback" }`) plus a `case "/feedback":` in the href switch (same
`?projectId=<id>` shape the default case already produces for Sprints/Epics/Metrics).
**Judgement call — flagged for confirmation:** placing it as a `ProjectNav` tab
(reachable at `/feedback?projectId=<id>`, alongside Sprints/Epics/Metrics) rather than
as a panel on the Overview page. A tab was chosen over an Overview panel because
feedback triage is an ongoing workflow with its own filter/action state (status
filter, source filter, convert-to-issue), the same shape Issues/Sprints already have
as tabs, not a glanceable summary metric the Overview page's other panels are.

### 1. Feedback list/triage view (new island, e.g. `FeedbackList.tsx`)

- **Props:** `{ workspaceSlug?: string }`, reading `projectId` from the URL query the
  same way `ProjectNav` does (`?projectId=<id>`).
- **Fetch:** `apiFetch<Feedback[]>(`/api/projects/${projectId}/feedback?status=${status}&sourceId=${sourceId}`, { workspaceSlug })` in a `useEffect` keyed on `[projectId, status, sourceId, workspaceSlug]` — same shape as `ProjectList`'s project-list fetch.
- **Renders:** rating (thumb icon or star count per `ratingScale`), `body`, **source
  name**, `status` badge, `submitterLabel`/`sourceUrl`/`appVersion` metadata,
  `createdAt`.
- **Filters:** a status filter (`new | reviewed | actioned | (all)`) **and** a source
  filter (by source name, `(all sources)` default), each driving its query param. The
  source filter reads the source list from `GET .../feedback-sources` (or a
  lightweight name lookup) so the human triaging can group feedback by which
  collection point it came from, not just by status.
- **Convert-to-issue action:** a button per row, `POST
  /api/projects/${projectId}/feedback/${id}/convert-to-issue`; on success, either
  navigates to the new issue or refetches the list with the row now showing
  `actioned` + a link to the linked issue. Member+ only — the button is hidden (not
  merely disabled) for a resolved `viewer` role, matching how write actions are
  hidden elsewhere rather than shown-then-403'd.

### 2. Source management UI (new island, e.g. `FeedbackSourceManager.tsx`)

Closely mirrors `TokenManager.tsx` — same shape (create/list a bearer credential),
different table/route and admin/owner-only gating instead of the viewer-vs-not gating
`TokenManager` currently doesn't even need to check client-side (the API 403s and
`TokenManager` catches that via `String(e).includes(": 403")`; the new island follows
the same reactive-403 pattern rather than pre-checking role client-side, since
`TokenManager` sets that precedent).

- **Props:** `{ workspaceSlug?: string; projectId: string }` (project-scoped, unlike
  `TokenManager`'s workspace-scoped props — a `feedback_sources` row belongs to a
  project, not a workspace).
- **List:** `apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, { workspaceSlug })` — renders each source's `name`, `description`, an active/inactive
  toggle (`PATCH { isActive }`), the hash-truncated **current** token, and
  `createdAt`.
- **Create (mint):** a form with a required **name**, optional **description**, and an
  optional multi-value "allowed origins" input (comma-separated or one-per-line,
  parsed to `string[]` client-side, omitted from the body entirely — not sent as `[]`
  — when left blank, so the server sees `undefined` and stores `NULL`); `POST
  .../feedback-sources` with `{ name, description?, allowedOrigins? }`.
- **Raw token shown once:** identical UX to `TokenManager`'s `NewTokenPanel` — same
  "copy this now, you won't see it again" warning, same clear-on-close behavior. A
  short embed snippet (`fetch("/api/feedback/submit", { headers: { Authorization:
  "Bearer <token>" }, ... })`) is a natural addition here but is explicitly **out of
  scope** for this island — see "Out of scope" below (no distributable widget).
- **Rotate:** a per-source action behind a **confirm dialog** (the old token stops
  working the instant rotation completes); `POST .../feedback-sources/${id}/rotate`,
  then show the new raw token once with the same shown-once UX as mint.
- **Revoke:** `DELETE .../feedback-sources/${id}`, then refetch — permanent, distinct
  from the reversible active/inactive toggle.

Where should this island be reachable from? **Judgement call — flagged for
confirmation:** the brief doesn't specify a location. The natural fit is a section
within the same Feedback tab (e.g. a "Manage sources" collapsible/sub-panel above or
beside the triage list, gated to render only for resolved admin/owner), rather than a
separate tab, since source management is a one-time/occasional setup action for the
same feature the triage list already lives under, not a frequently-visited page in
its own right — this mirrors how `TokenManager` itself isn't a top-level nav tab.

## Testing plan

### `apps/api/src/test/feedback.test.ts` (new, per-domain convention)

Do **not** add to `mcp.test.ts` or `authorization.test.ts` (per `AGENTS.md`'s
per-domain test-file convention). The MCP-tool tests for the five management tools go
in a `describe` block in this same file, alongside the REST tests, mirroring how
`comments`/`issue-links` test their MCP tools next to their REST coverage. Cover:

- Source creation: 201 for admin/owner, 403 for member/viewer; returns `{ id, token }`
  with the raw token present exactly once.
- Source listing: hash-truncated current token, never the raw token; includes `name`/
  `description`/`isActive`; 403 for member/viewer.
- Source update (`PATCH`): `name`/`description`/`isActive` updated; 403 for
  member/viewer.
- **Rotation:** `POST .../rotate` returns a new raw token; the old token no longer
  authenticates a submit (401), the new one does; the source's `id`, `name`,
  `description`, and its existing `feedback` rows are unchanged (assert same `id`, same
  `feedback.source_id` still resolves, history intact). 403 for member/viewer.
- Revocation (`DELETE`): sets `revoked_at`; 403 for member/viewer.
- Submit happy path: valid, active, unrevoked token → `{ id }`, row inserted with
  `source_id`/`project_id`/`workspace_id` resolved from the source, not the body.
- Submit with revoked source → **401**.
- Submit with **inactive** source (`is_active = 0`) → **403** (kill switch, not a
  silent success).
- Submit with unknown/garbage token → 401.
- **Cross-source / cross-project isolation:** a token minted for source A (project A),
  used to submit, never creates a `feedback` row under source B or project B — assert
  the inserted row's `source_id`/`project_id` always match the token's source,
  regardless of any source/project-shaped field a malicious body might include.
- Rate-limit trip (token-keyed and IP-keyed) → 429.
- CORS header presence/absence: a source with an explicit `allowedOrigins` list returns
  `Access-Control-Allow-Origin` matching a listed origin and omits it for a
  non-listed `Origin` header; a source with `allowedOrigins: null` never returns the
  header regardless of `Origin`. Include an `OPTIONS` preflight case.
- Validation: `{ rating: undefined, body: undefined }` → 400 (at-least-one-of
  failure); `rating` present without `ratingScale` → 400.
- `GET .../feedback`: visible only to a role with project access (404 for none, per
  `requireProjectAccess`); `status` and `sourceId` filters narrow results.
- `PATCH .../feedback/:id`: 403 for viewer, succeeds for member+, updates `status`.
- Convert-to-issue: creates an issue via the real `createIssue` path, sets
  `linked_issue_id` + `status: "actioned"` on the feedback row, returns the new issue;
  403 for viewer.
- **MCP tools:** `create_feedback_source` / `list_feedback_sources` /
  `update_feedback_source` / `rotate_feedback_source_token` / `revoke_feedback_source`
  each dispatch through the MCP surface, enforce the admin/owner guard (member/viewer
  get the JSON-RPC error the MCP error-adapter maps `ForbiddenError` to), and return
  the same shapes as their REST equivalents (raw token once for create/rotate,
  hash-truncated for list).

### Web island tests

`FeedbackList.test.tsx` and `FeedbackSourceManager.test.tsx`, following the existing
mock-fetch pattern (`vi.stubGlobal("fetch", vi.fn().mockImplementation(...))`,
branching on `url.includes(...)`, `await screen.findBy*`) established in
`TokenManager.test.tsx` and `ProjectNav.test.tsx`. Cover: list rendering, status and
source filters changing the fetched URL, convert-to-issue firing the right `POST` and
updating the row, source create/list/rotate/revoke round-trip, the active/inactive
toggle firing the right `PATCH`, and the raw-token-shown-once UX for both mint and
rotate.

## Out of scope for this design

- **Cloudflare Turnstile / bot-check.** Discussed and deferred for v1 — rate limiting
  + per-source CORS is the v1 abuse-control bar. A natural follow-up if abuse becomes
  a real problem once the feature is live.
- **An embeddable client-side widget/script** for product teams to drop into their
  own sites (a `<script src="...feedback-widget.js">` or npm package). This design
  covers the projektor-side API and projektor's own triage/source-management UI only —
  not a distributable feedback-widget library. A caller integrates directly against
  `POST /api/feedback/submit` with their own UI in v1.
- **The Cloudflare Access Zero Trust policy change itself.** The infra prerequisite
  described above lives in `projektor-workspace`, not this repo, and its exact
  mechanism (path-scoped bypass vs. a second Access Application) is an infra
  decision for whoever owns that config — this design flags it as a blocker to raise,
  it does not design the policy.
- **Server-to-server-specific tooling** (webhook forwarding, SDKs, retry semantics for
  backend integrators). A `null`-origin source's token already supports this pattern
  with zero additional design; nothing further is scoped here.

## Follow-up implementation tickets

### Ticket 1: Feedback data model + submit endpoint

Body:

> Add `feedback_sources` and `feedback` tables and the public
> `POST /api/feedback/submit` endpoint per `docs/design/proj-378-feedback-ingestion.md`
> — the ingestion side of direct user feedback. Excluded from `authMiddleware`,
> excluded from CF Access at the edge (separate infra ticket, not this one).
>
> **Acceptance criteria:**
> - Migration `packages/db/migrations/00XX_feedback.sql` adds both tables per the
>   design doc's schema (`feedback_sources` with separate `id`/`token_hash`,
>   `feedback` parented on `source_id`); registered in `apps/api/src/test/migrations.ts`.
> - `schemas/feedback.ts`: `SubmitFeedbackSchema` (at-least-one-of `rating`/`body`,
>   `ratingScale` required iff `rating` present) and `CreateFeedbackSourceSchema`
>   (`name`, `description?`, `allowedOrigins?: string[]`).
> - `services/feedback.ts`: `submitFeedback` (token verification, revoked→401,
>   inactive→403, CORS resolution, insert — no `ServiceCtx`), `listFeedback`/
>   `updateFeedbackStatus` (via `requireProjectAccess`/`canWriteProject`).
> - `services/feedback-sources.ts`: `createFeedbackSource`/`listFeedbackSources`/
>   `updateFeedbackSource`/`rotateFeedbackSourceToken`/`revokeFeedbackSource`,
>   admin/owner-gated via `isWorkspaceAdmin`.
> - `routes/feedback.ts` (public submit router + authenticated list/patch router) and
>   `routes/feedback-sources.ts`, mounted in `index.ts` per the design doc's mounting
>   notes (public submit router before the auth block, like `sharePublicRouter`).
> - Dual-keyed rate limiting via `bumpRateCounter` on the submit route.
> - Tests per the "Testing plan" section above, in `test/feedback.test.ts`.
>
> **Scope / files:** `packages/db/migrations/00XX_feedback.sql`,
> `apps/api/src/test/migrations.ts`, `apps/api/src/schemas/feedback.ts`,
> `apps/api/src/services/feedback.ts`, `apps/api/src/services/feedback-sources.ts`,
> `apps/api/src/routes/feedback.ts`, `apps/api/src/routes/feedback-sources.ts`,
> `apps/api/src/index.ts`, `apps/api/src/test/feedback.test.ts`.
>
> **Verification:** `pnpm --filter @projektor/api test feedback`; manual `curl` to
> `POST /api/feedback/submit` with a minted token against local dev confirms the
> insert and the `{ id }`-only response shape.

### Ticket 2: Source management MCP tools

Body:

> Add the five source-management MCP tools in `apps/api/src/mcp/feedback.ts`, composed
> into `routes/mcp.ts`, giving source management full REST + MCP parity per
> `docs/design/proj-378-feedback-ingestion.md`. Depends on Ticket 1's service layer.
>
> **Acceptance criteria:**
> - `create_feedback_source`, `list_feedback_sources`, `update_feedback_source`,
>   `rotate_feedback_source_token`, `revoke_feedback_source` — each delegates to the
>   corresponding `services/feedback-sources.ts` function, shares the same Zod schema,
>   and wires errors through `mcp/error-adapter.ts`.
> - Rich, agent-facing tool descriptions per the design doc (explain what a source is,
>   raw-token-shown-once, rotate-vs-revoke).
> - `submit_feedback` is **not** added — the deliberate asymmetry.
> - MCP tool tests in `test/feedback.test.ts` per the Testing plan.
>
> **Scope / files:** `apps/api/src/mcp/feedback.ts`, `apps/api/src/routes/mcp.ts`,
> `apps/api/src/test/feedback.test.ts`.
>
> **Verification:** `pnpm --filter @projektor/api test feedback`.

### Ticket 3: Convert-to-issue

Body:

> Add `POST /api/projects/:id/feedback/:feedbackId/convert-to-issue`, reusing the
> existing `createIssue` service (`services/issues.ts`) per the field mapping in
> `docs/design/proj-378-feedback-ingestion.md`. Depends on Ticket 1's `feedback`
> table.
>
> **Acceptance criteria:**
> - `services/feedback.ts` gains `convertFeedbackToIssue(ctx, projectId,
>   feedbackId)`: builds the `createIssue` payload server-side from the feedback row
>   (title truncation / body footer per the design doc — confirm the exact wording/
>   length with product before merging, flagged as a judgement call in the design),
>   calls `createIssue`, then sets `linked_issue_id`/`status: "actioned"` on the
>   feedback row, returns the created issue.
> - member+ guard (`canWriteProject`), 403 for viewer.
> - Test: end-to-end conversion sets both fields and returns the real issue; viewer
>   gets 403.
>
> **Scope / files:** `apps/api/src/services/feedback.ts`, `apps/api/src/routes/
> feedback.ts`, `apps/api/src/test/feedback.test.ts`.
>
> **Verification:** `pnpm --filter @projektor/api test feedback`.

### Ticket 4: Web UI — triage list + source management islands

Body:

> Add `FeedbackList.tsx` and `FeedbackSourceManager.tsx` Preact islands per
> `docs/design/proj-378-feedback-ingestion.md`, plus the new `ProjectNav` tab.
> Depends on Tickets 1–3 for the API surface.
>
> **Acceptance criteria:**
> - `ProjectNav.tsx` `TABS` gains a "Feedback" entry; href switch handles it like
>   Sprints/Epics/Metrics (`?projectId=<id>`).
> - `FeedbackList.tsx`: lists feedback with status + source filters and convert-to-issue
>   action (member+ only, hidden for viewer), using `apiFetch` exclusively.
> - `FeedbackSourceManager.tsx`: create (name/description/origins) / list / rotate
>   (confirm dialog) / revoke / active-toggle, admin/owner-only, mirrors
>   `TokenManager.tsx`'s raw-token-shown-once UX for both mint and rotate; placement
>   within the Feedback tab per the design doc (confirm exact placement — flagged as a
>   judgement call).
> - Tests: `FeedbackList.test.tsx`, `FeedbackSourceManager.test.tsx`, mock-fetch style
>   matching `TokenManager.test.tsx`/`ProjectNav.test.tsx`.
>
> **Scope / files:** `apps/web/src/islands/FeedbackList.tsx`,
> `apps/web/src/islands/FeedbackSourceManager.tsx`,
> `apps/web/src/islands/ProjectNav.tsx`, corresponding `.test.tsx` files, and
> whatever Astro page mounts the Feedback tab route (matching the existing
> Sprints/Epics/Metrics page pattern).
>
> **Verification:** `pnpm --filter @projektor/web test`; `pnpm --filter @projektor/web build`.

### Ticket 5 (infra, tracked separately, not in this repo): Exclude feedback submit from CF Access

Body:

> Configure a path-scoped Cloudflare Zero Trust Access bypass (or a dedicated Access
> Application) for `POST /api/feedback/submit` (and its `OPTIONS` preflight) in
> `projektor-workspace`, so real external browser traffic can reach the endpoint
> shipped by Ticket 1. Blocks the feature from being usable in production even after
> Tickets 1–4 merge and deploy. See "Deployment blocker" in
> `docs/design/proj-378-feedback-ingestion.md`.
>
> **Scope:** `projektor-workspace` Zero Trust config — not this repo.

All five tickets are children of the same feature; Tickets 2–4 depend on Ticket 1's
table/schema/service landing first. Ticket 5 has no code dependency on 1–4 but must
land before the feature is externally usable.
