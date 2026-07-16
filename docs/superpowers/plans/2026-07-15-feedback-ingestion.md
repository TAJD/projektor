# Feedback Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct end-user feedback ingestion to projektor — named, independently-credentialed *feedback sources* that external product code submits against, plus in-app triage that turns feedback into issues.

**Architecture:** Follows the established per-domain layout (migration → `schemas/` → `services/` → `routes/` → `mcp/` → `test/` → web islands). The public `POST /api/feedback/submit` verifies a source's token inline (raw-D1 hash lookup, exactly like `services/share.ts::getSharedIssue`), never routed through `middleware/auth.ts`. Source *management* (create/list/update/rotate/revoke) is authenticated, workspace-scoped, admin/owner-only, and exposed on both REST and MCP. Feedback triage (list/patch/convert-to-issue) reuses the PROJ-311 group-access helpers and the existing `createIssue` service.

**Tech Stack:** Cloudflare Workers, Hono, D1 (raw prepared statements + drizzle-orm where a domain already uses it), Zod, vitest + `@cloudflare/vitest-pool-workers`, Astro + Preact islands, Tailwind utility classes.

## Global Constraints

Copied from `AGENTS.md` and `docs/design/proj-378-feedback-ingestion.md` — every task's requirements implicitly include these:

- **Security invariant — always scope by workspace.** Every query MUST be scoped by `workspace_id` (directly, or via a parent entity that was itself workspace-checked). A missing scope is a cross-tenant data leak.
- **Services own all business logic, SQL, and validation.** Route/MCP wrappers stay thin: build ctx, call service, adapt errors. Validation happens inside the service via a shared Zod schema in `schemas/feedback.ts` — never trust raw `unknown` in a wrapper.
- **Typed errors + adapters.** Services throw `ValidationError` / `NotFoundError` / `ForbiddenError` / `ConflictError` from `services/errors.ts`. REST maps via `http/error-adapter.ts::serviceErrToResponse` (400/404/403/409); MCP maps via `mcp/error-adapter.ts::toMcpError` (`-32602` validation, `-32000` otherwise). Never return raw `String(err)` to clients.
- **REST↔MCP parity.** Authenticated domains get both surfaces. Source management gets both. The one deliberate exception: `POST /api/feedback/submit` is REST-only (external, unauthenticated-by-session, anonymous — no agent on the other end).
- **NotFound-before-Forbidden ordering.** Resolve/verify the resource scoped to the workspace first (404 if absent — hides existence), *then* check role (403). Invisible projects 404, never 403 (`requireProjectAccess`).
- **D1 100-bound-parameter limit.** Any variable-length `IN`/`inArray` must go through `inChunks` (`services/sql.ts`). None of this feature's queries bind a row-scaled array, so `inChunks` is not needed here — but do not introduce one.
- **Conventions:** camelCase at the API boundary, snake_case in the DB. JSON columns stored via `JSON.stringify`, parsed by callers. Timestamps are `Math.floor(Date.now()/1000)`. IDs are `crypto.randomUUID()`. Token hashes are sha256 hex.
- **Migration registration.** Every new `.sql` in `packages/db/migrations/` MUST also get a `?raw` import + `MIGRATIONS` array entry in `apps/api/src/test/migrations.ts`, or the test DB silently lacks the table (a past omission caused 29 failures).
- **Per-domain test file.** All feedback tests (REST *and* MCP) live in `apps/api/src/test/feedback.test.ts`. Do not add to `mcp.test.ts` / `authorization.test.ts`.

---

## File Structure

**API (`apps/api/src/`)**

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `packages/db/migrations/0036_feedback.sql` | Create | `feedback_sources` + `feedback` tables and indexes |
| `apps/api/src/test/migrations.ts` | Modify | Register migration 0036 |
| `schemas/feedback.ts` | Create | All Zod schemas (submit + source management + triage) |
| `services/feedback-sources.ts` | Create | Source CRUD + rotate + revoke (admin/owner-gated) |
| `services/feedback.ts` | Create | `submitFeedback`, `listFeedback`, `updateFeedbackStatus`, `convertFeedbackToIssue`, `hashFeedbackToken` |
| `routes/feedback-sources.ts` | Create | REST wrapper for source management (mounted `/api/projects`) |
| `routes/feedback.ts` | Create | Public submit router (+OPTIONS) and authed triage router |
| `mcp/feedback.ts` | Create | Five source-management MCP tools |
| `routes/mcp.ts` | Modify | Compose `feedbackTools` |
| `index.ts` | Modify | Mount public submit router (before global logger/cors), source + triage routers (authed block) |
| `test/feedback.test.ts` | Create | REST + MCP integration tests |
| `packages/types/src/env.ts` | Modify | Add `RATE_LIMIT_FEEDBACK_MAX` / `RATE_LIMIT_FEEDBACK_IP_MAX` |
| `apps/api/wrangler.test.toml` | Modify | Low test values for the two new rate-limit env vars |

**Web (`apps/web/src/`)**

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `islands/FeedbackSourceManager.tsx` | Create | Mint/list/rotate/revoke/toggle sources (admin/owner-only) |
| `islands/FeedbackList.tsx` | Create | Triage list with status + source filters, convert-to-issue |
| `islands/ProjectNav.tsx` | Modify | Add "Feedback" tab |
| `pages/feedback.astro` | Create | Mounts ProjectNav + the two islands |
| `islands/FeedbackSourceManager.test.tsx` | Create | Mock-fetch island tests |
| `islands/FeedbackList.test.tsx` | Create | Mock-fetch island tests |

**Task order:** 1 migration → 2 schemas → 3 source-management (service+REST) → 4 public submit (service+route+mount) → 5 triage read/patch → 6 convert-to-issue → 7 MCP tools → 8 nav tab + page → 9 source-manager island → 10 triage-list island. Each task ends with a passing test and a commit.

---

## Task 1: Migration — `feedback_sources` + `feedback` tables

**Files:**
- Create: `packages/db/migrations/0036_feedback.sql`
- Modify: `apps/api/src/test/migrations.ts`
- Test: `apps/api/src/test/feedback.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `feedback_sources(id, token_hash, workspace_id, project_id, name, description, is_active, allowed_origins, created_by, created_at, revoked_at)` and `feedback(id, source_id, workspace_id, project_id, rating, rating_scale, body, submitter_label, source_url, app_version, status, linked_issue_id, created_at)`; indexes `idx_feedback_sources_project`, `idx_feedback_source_status`, `idx_feedback_project_status`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/feedback.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("feedback migration", () => {
	it("creates feedback_sources and feedback tables", async () => {
		const src = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_sources'"
		).first<{ name: string }>();
		expect(src?.name).toBe("feedback_sources");

		const fb = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'"
		).first<{ name: string }>();
		expect(fb?.name).toBe("feedback");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — `feedback_sources` table not found (migration doesn't exist / isn't registered).

- [ ] **Step 3: Create the migration**

Create `packages/db/migrations/0036_feedback.sql` (matches the `-- PROJ-XXX:` header + backtick-identifier style of 0034/0035):

```sql
-- PROJ-378: direct user feedback ingestion. A `feedback_source` is a named,
-- independently-credentialed collection point an admin sets up; external product
-- code submits against its token. `id` is the source's stable identity (every
-- feedback row points at it); `token_hash` is the rotatable credential kept in a
-- separate column so rotation never loses the source's identity/history.
CREATE TABLE `feedback_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`allowed_origins` text,
	`created_by` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
CREATE UNIQUE INDEX `idx_feedback_sources_token_hash` ON `feedback_sources` (`token_hash`);
CREATE INDEX `idx_feedback_sources_project` ON `feedback_sources` (`project_id`);

CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL REFERENCES `feedback_sources`(`id`) ON DELETE CASCADE,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
	`rating` integer,
	`rating_scale` text,
	`body` text,
	`submitter_label` text,
	`source_url` text,
	`app_version` text,
	`status` text DEFAULT 'new' NOT NULL,
	`linked_issue_id` text REFERENCES `issues`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `idx_feedback_source_status` ON `feedback` (`source_id`,`status`);
CREATE INDEX `idx_feedback_project_status` ON `feedback` (`project_id`,`status`);
```

- [ ] **Step 4: Register the migration**

In `apps/api/src/test/migrations.ts`, add the import after the `m0035` line:

```ts
import m0036 from "../../../../packages/db/migrations/0036_feedback.sql?raw";
```

and append `m0036,` after `m0035,` in the `MIGRATIONS` array:

```ts
	m0035,
	m0036,
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0036_feedback.sql apps/api/src/test/migrations.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): add feedback_sources + feedback tables (PROJ-378)"
```

---

## Task 2: Zod schemas — `schemas/feedback.ts`

**Files:**
- Create: `apps/api/src/schemas/feedback.ts`
- Test: `apps/api/src/test/feedback-schemas.test.ts` (new — pure unit test, no DB)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `schemas/feedback.ts`):
  - `SubmitFeedbackSchema` → `{ rating?: number; ratingScale?: "thumbs"|"five_star"; body?: string; submitterLabel?: string; sourceUrl?: string; appVersion?: string }` with at-least-one-of(rating,body) and ratingScale-iff-rating refinements.
  - `CreateFeedbackSourceSchema` → `{ projectId: string; name: string; description?: string; allowedOrigins?: string[] }`.
  - `ListFeedbackSourcesSchema` → `{ projectId: string }`.
  - `UpdateFeedbackSourceSchema` → `{ sourceId: string; name?: string; description?: string|null; isActive?: boolean }` with at-least-one-of refinement.
  - `RotateFeedbackSourceSchema` → `{ sourceId: string }`.
  - `RevokeFeedbackSourceSchema` → `{ sourceId: string }`.
  - `ListFeedbackSchema` → `{ projectId: string; status?: string; sourceId?: string }`.
  - `UpdateFeedbackSchema` → `{ projectId: string; feedbackId: string; status: "new"|"reviewed"|"actioned" }`.
  - `ConvertFeedbackSchema` → `{ projectId: string; feedbackId: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/feedback-schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	CreateFeedbackSourceSchema,
	SubmitFeedbackSchema,
	UpdateFeedbackSourceSchema,
} from "../schemas/feedback";

describe("SubmitFeedbackSchema", () => {
	it("accepts a body-only submission", () => {
		expect(SubmitFeedbackSchema.safeParse({ body: "great" }).success).toBe(true);
	});
	it("accepts rating + ratingScale", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 5, ratingScale: "five_star" }).success).toBe(true);
	});
	it("rejects empty submission (neither rating nor body)", () => {
		expect(SubmitFeedbackSchema.safeParse({}).success).toBe(false);
	});
	it("rejects rating without ratingScale", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 5 }).success).toBe(false);
	});
	it("rejects ratingScale without rating", () => {
		expect(SubmitFeedbackSchema.safeParse({ body: "x", ratingScale: "thumbs" }).success).toBe(false);
	});
});

describe("CreateFeedbackSourceSchema", () => {
	it("requires a name", () => {
		expect(CreateFeedbackSourceSchema.safeParse({ projectId: "p", name: "Onboarding" }).success).toBe(true);
		expect(CreateFeedbackSourceSchema.safeParse({ projectId: "p" }).success).toBe(false);
	});
});

describe("UpdateFeedbackSourceSchema", () => {
	it("requires at least one mutable field", () => {
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s" }).success).toBe(false);
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s", isActive: false }).success).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback-schemas`
Expected: FAIL — cannot import from `../schemas/feedback` (module doesn't exist).

- [ ] **Step 3: Create the schema module**

Create `apps/api/src/schemas/feedback.ts`:

```ts
import { z } from "zod";

const RatingScaleEnum = z.enum(["thumbs", "five_star"]);
const FeedbackStatusEnum = z.enum(["new", "reviewed", "actioned"]);

export const SubmitFeedbackSchema = z
	.object({
		rating: z.number().int().optional(),
		ratingScale: RatingScaleEnum.optional(),
		body: z.string().min(1).max(10000).optional(),
		submitterLabel: z.string().max(200).optional(),
		sourceUrl: z.string().max(2000).optional(),
		appVersion: z.string().max(100).optional(),
	})
	.refine((d) => d.rating !== undefined || d.body !== undefined, {
		message: "At least one of rating or body must be provided",
	})
	.refine((d) => (d.rating === undefined) === (d.ratingScale === undefined), {
		message: "ratingScale is required when rating is present, and forbidden otherwise",
	});

export const CreateFeedbackSourceSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	allowedOrigins: z.array(z.string().max(2000)).max(50).optional(),
});

export const ListFeedbackSourcesSchema = z.object({
	projectId: z.string().uuid(),
});

export const UpdateFeedbackSourceSchema = z
	.object({
		sourceId: z.string(),
		name: z.string().min(1).max(100).optional(),
		description: z.string().max(500).nullable().optional(),
		isActive: z.boolean().optional(),
	})
	.refine((d) => d.name !== undefined || d.description !== undefined || d.isActive !== undefined, {
		message: "At least one of name, description, or isActive must be provided",
	});

export const RotateFeedbackSourceSchema = z.object({ sourceId: z.string() });
export const RevokeFeedbackSourceSchema = z.object({ sourceId: z.string() });

export const ListFeedbackSchema = z.object({
	projectId: z.string().uuid(),
	status: FeedbackStatusEnum.optional(),
	sourceId: z.string().optional(),
});

export const UpdateFeedbackSchema = z.object({
	projectId: z.string().uuid(),
	feedbackId: z.string(),
	status: FeedbackStatusEnum,
});

export const ConvertFeedbackSchema = z.object({
	projectId: z.string().uuid(),
	feedbackId: z.string(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback-schemas`
Expected: PASS (all 8 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/feedback.ts apps/api/src/test/feedback-schemas.test.ts
git commit -m "feat(feedback): add zod schemas for submit + source management (PROJ-378)"
```

---

## Task 3: Source management — service + REST routes

**Files:**
- Create: `apps/api/src/services/feedback-sources.ts`
- Create: `apps/api/src/routes/feedback-sources.ts`
- Modify: `apps/api/src/index.ts` (mount `feedbackSourcesRouter` in the authed block)
- Test: `apps/api/src/test/feedback.test.ts`

**Interfaces:**
- Consumes: `ServiceCtx`, `ctxFromHono` (`services/types.ts`); `isWorkspaceAdmin` (`services/access.ts`); `ValidationError`/`NotFoundError`/`ForbiddenError` (`services/errors.ts`); schemas from Task 2; `serviceErrToResponse` (`http/error-adapter.ts`).
- Produces (exported from `services/feedback-sources.ts`):
  - `createFeedbackSource(ctx: ServiceCtx, input: unknown): Promise<{ id: string; token: string }>`
  - `listFeedbackSources(ctx: ServiceCtx, input: unknown): Promise<FeedbackSourceView[]>` where `FeedbackSourceView = { id, name, description, isActive, allowedOrigins, tokenPreview, createdAt, revokedAt }`
  - `updateFeedbackSource(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }>`
  - `rotateFeedbackSourceToken(ctx: ServiceCtx, input: unknown): Promise<{ token: string }>`
  - `revokeFeedbackSource(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }>`
  - REST: `POST/GET /api/projects/:id/feedback-sources`, `PATCH/DELETE /api/projects/:id/feedback-sources/:sourceId`, `POST .../:sourceId/rotate`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/feedback.test.ts` (add these imports at the top of the file, keeping the existing `env` import):

```ts
import { SELF } from "cloudflare:test";
import { authHeaders, seedProjectFixture, seedWorkspaceRoles, seedProject, seedGroupGrant } from "./helpers";

describe("Feedback sources REST", () => {
	it("creates a source (owner) and returns a one-time token", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "Onboarding survey", allowedOrigins: ["https://acme.test"] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; token: string };
		expect(body.id).toBeTruthy();
		expect(body.token).toBeTruthy();
	});

	it("rejects source creation by a member (403)", async () => {
		const f = await seedProjectFixture({ role: "member" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "X" }),
		});
		expect(res.status).toBe(403);
	});

	it("lists sources with a truncated token preview, never the raw token", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "NPS" }),
		});
		const { token } = (await created.json()) as { token: string };

		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as Array<{ name: string; tokenPreview: string; isActive: boolean }>;
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("NPS");
		expect(list[0].isActive).toBe(true);
		expect(list[0].tokenPreview.length).toBeLessThan(token.length);
		expect(JSON.stringify(list)).not.toContain(token);
	});

	it("updates name/description/isActive (owner)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "Old" }),
		});
		const { id } = (await created.json()) as { id: string };

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`,
			{
				method: "PATCH",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ name: "New", isActive: false }),
			}
		);
		expect(res.status).toBe(200);
		const row = await env.DB.prepare("SELECT name, is_active FROM feedback_sources WHERE id = ?")
			.bind(id)
			.first<{ name: string; is_active: number }>();
		expect(row?.name).toBe("New");
		expect(row?.is_active).toBe(0);
	});

	it("revoke stamps revoked_at (owner); member is 403", async () => {
		const roles = await seedWorkspaceRoles();
		const proj = await seedProject(roles.workspace.id, "FBK");
		const create = await SELF.fetch(`http://localhost/api/projects/${proj.id}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ name: "S" }),
		});
		const { id } = (await create.json()) as { id: string };

		const memberRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback-sources/${id}`,
			{ method: "DELETE", headers: authHeaders(roles.member.token, roles.workspace.slug) }
		);
		expect(memberRes.status).toBe(403);

		const ownerRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback-sources/${id}`,
			{ method: "DELETE", headers: authHeaders(roles.owner.token, roles.workspace.slug) }
		);
		expect(ownerRes.status).toBe(200);
		const row = await env.DB.prepare("SELECT revoked_at FROM feedback_sources WHERE id = ?")
			.bind(id)
			.first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — 404s from unmounted routes / missing service module.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/feedback-sources.ts`:

```ts
import {
	CreateFeedbackSourceSchema,
	ListFeedbackSourcesSchema,
	RevokeFeedbackSourceSchema,
	RotateFeedbackSourceSchema,
	UpdateFeedbackSourceSchema,
} from "../schemas/feedback";
import { isWorkspaceAdmin } from "./access";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export interface FeedbackSourceView {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function newRawToken(): string {
	return `fbk_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

interface SourceRow {
	id: string;
	token_hash: string;
	name: string;
	description: string | null;
	is_active: number;
	allowed_origins: string | null;
	created_at: number;
	revoked_at: number | null;
}

async function requireProjectInWorkspace(ctx: ServiceCtx, projectId: string): Promise<void> {
	const project = await ctx.db
		.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
		.bind(projectId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!project) throw new NotFoundError("Project not found");
}

// Resolve a source scoped to the workspace (404 before any role check). Management
// ops take only a sourceId; the project is resolved from the source row.
async function requireSource(ctx: ServiceCtx, sourceId: string): Promise<SourceRow> {
	const row = await ctx.db
		.prepare(
			`SELECT id, token_hash, name, description, is_active, allowed_origins, created_at, revoked_at
       FROM feedback_sources WHERE id = ? AND workspace_id = ?`
		)
		.bind(sourceId, ctx.workspaceId)
		.first<SourceRow>();
	if (!row) throw new NotFoundError("Feedback source not found");
	return row;
}

export async function createFeedbackSource(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; token: string }> {
	const parsed = CreateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, name, description, allowedOrigins } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const token = newRawToken();
	const tokenHash = await sha256hex(token);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await ctx.db
		.prepare(
			`INSERT INTO feedback_sources
       (id, token_hash, workspace_id, project_id, name, description, is_active, allowed_origins, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`
		)
		.bind(
			id,
			tokenHash,
			ctx.workspaceId,
			projectId,
			name,
			description ?? null,
			allowedOrigins ? JSON.stringify(allowedOrigins) : null,
			ctx.userId,
			now
		)
		.run();

	return { id, token };
}

export async function listFeedbackSources(
	ctx: ServiceCtx,
	input: unknown
): Promise<FeedbackSourceView[]> {
	const parsed = ListFeedbackSourcesSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const { results } = await ctx.db
		.prepare(
			`SELECT id, token_hash, name, description, is_active, allowed_origins, created_at, revoked_at
       FROM feedback_sources WHERE project_id = ? AND workspace_id = ? ORDER BY created_at DESC`
		)
		.bind(projectId, ctx.workspaceId)
		.all<SourceRow>();

	return (results ?? []).map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		isActive: r.is_active === 1,
		allowedOrigins: r.allowed_origins ? (JSON.parse(r.allowed_origins) as string[]) : null,
		tokenPreview: `${r.token_hash.slice(0, 12)}…`,
		createdAt: r.created_at,
		revokedAt: r.revoked_at,
	}));
}

export async function updateFeedbackSource(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ ok: true }> {
	const parsed = UpdateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId, name, description, isActive } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const sets: string[] = [];
	const binds: unknown[] = [];
	if (name !== undefined) {
		sets.push("name = ?");
		binds.push(name);
	}
	if (description !== undefined) {
		sets.push("description = ?");
		binds.push(description);
	}
	if (isActive !== undefined) {
		sets.push("is_active = ?");
		binds.push(isActive ? 1 : 0);
	}
	binds.push(sourceId, ctx.workspaceId);

	await ctx.db
		.prepare(`UPDATE feedback_sources SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`)
		.bind(...binds)
		.run();

	return { ok: true };
}

export async function rotateFeedbackSourceToken(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ token: string }> {
	const parsed = RotateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const token = newRawToken();
	const tokenHash = await sha256hex(token);
	await ctx.db
		.prepare("UPDATE feedback_sources SET token_hash = ? WHERE id = ? AND workspace_id = ?")
		.bind(tokenHash, sourceId, ctx.workspaceId)
		.run();

	return { token };
}

export async function revokeFeedbackSource(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ ok: true }> {
	const parsed = RevokeFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const now = Math.floor(Date.now() / 1000);
	await ctx.db
		.prepare("UPDATE feedback_sources SET revoked_at = ? WHERE id = ? AND workspace_id = ?")
		.bind(now, sourceId, ctx.workspaceId)
		.run();

	return { ok: true };
}
```

- [ ] **Step 4: Write the REST router**

Create `apps/api/src/routes/feedback-sources.ts`:

```ts
import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createFeedbackSource,
	listFeedbackSources,
	revokeFeedbackSource,
	rotateFeedbackSourceToken,
	updateFeedbackSource,
} from "../services/feedback-sources";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.post("/:id/feedback-sources", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const raw = await c.req.json();
	try {
		return c.json(await createFeedbackSource(ctx, { projectId, ...raw }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id/feedback-sources", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	try {
		return c.json(await listFeedbackSources(ctx, { projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:id/feedback-sources/:sourceId", async (c) => {
	const ctx = ctxFromHono(c);
	const sourceId = c.req.param("sourceId");
	const raw = await c.req.json();
	try {
		return c.json(await updateFeedbackSource(ctx, { sourceId, ...raw }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/feedback-sources/:sourceId/rotate", async (c) => {
	const ctx = ctxFromHono(c);
	const sourceId = c.req.param("sourceId");
	try {
		return c.json(await rotateFeedbackSourceToken(ctx, { sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id/feedback-sources/:sourceId", async (c) => {
	const ctx = ctxFromHono(c);
	const sourceId = c.req.param("sourceId");
	try {
		return c.json(await revokeFeedbackSource(ctx, { sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as feedbackSourcesRouter };
```

- [ ] **Step 5: Mount the router**

In `apps/api/src/index.ts`, add the import alongside the other route imports (after the `codeHeatmapRouter` import):

```ts
import { feedbackSourcesRouter } from "./routes/feedback-sources";
```

and mount it in the authed block next to `projectsRouter` (the existing `app.use("/api/projects/*", authMiddleware, workspaceMiddleware)` at lines 195-196 already covers these paths — no new `app.use` needed):

```ts
app.route("/api/projects", projectsRouter);
app.route("/api/projects", feedbackSourcesRouter);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS (the 5 "Feedback sources REST" tests plus the Task 1 migration test).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/feedback-sources.ts apps/api/src/routes/feedback-sources.ts apps/api/src/index.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): source management service + REST routes (PROJ-378)"
```

---

## Task 4: Public submit — service + route + mount

**Files:**
- Create: `apps/api/src/services/feedback.ts`
- Create: `apps/api/src/routes/feedback.ts`
- Modify: `apps/api/src/index.ts` (mount public router before the global `logger()`/`cors()` middleware)
- Modify: `packages/types/src/env.ts` (add `RATE_LIMIT_FEEDBACK_MAX` / `RATE_LIMIT_FEEDBACK_IP_MAX`)
- Modify: `apps/api/wrangler.test.toml` (test values for the new env vars)
- Test: `apps/api/src/test/feedback.test.ts`

**Interfaces:**
- Consumes: schemas from Task 2; `ValidationError`/`NotFoundError`/`ForbiddenError`; `feedback_sources` table (Task 1); `bumpRateCounter` (`middleware/rate-limit.ts`); `RATE_LIMIT_FEEDBACK_MAX`/`RATE_LIMIT_FEEDBACK_IP_MAX` (`packages/types/src/env.ts`, added by this task).
- Produces (exported from `services/feedback.ts`):
  - `hashFeedbackToken(token: string): Promise<string>`
  - `submitFeedback(db: D1Database, token: string, rawBody: unknown, requestOrigin: string | null): Promise<{ id: string; corsAllowOrigin: string | null }>` — throws `NotFoundError` (unknown/revoked → route maps to 401), `ForbiddenError` (inactive → 403), `ValidationError` (bad body → 400).
  - Public REST: `OPTIONS /api/feedback/submit`, `POST /api/feedback/submit`.

**Design notes (read before implementing):**
- Rejection codes: unknown token → 401, revoked → 401, inactive → 403, rate-limit → 429, bad body → 400. The service throws `NotFoundError` for unknown/revoked; the submit route's local adapter maps `NotFoundError` → **401** for this endpoint specifically (all other endpoints keep 404).
- CORS is browser-enforced, not a server-side block: the POST always inserts when the token is valid + active; it sets `Access-Control-Allow-Origin` **only** when the request `Origin` is in the source's `allowed_origins` list. A `null` `allowed_origins` never yields the header. Origin-mismatch is NOT a rejection — it just omits the header (per the design doc).
- The public router is mounted **before** the global `app.use("*", logger())` and `app.use("*", cors())` in `index.ts` (not merely before auth). This is required: the global cors is an allowlist that by design excludes third-party feedback origins, and Hono's cors middleware short-circuits the `OPTIONS` preflight — so if feedback sat behind it, no third-party browser preflight could succeed. Mounting first lets the route own its per-source CORS. This is the same "register the route before the `.use()` you need it to skip" technique already used for `/api/health` (`index.ts:62`, registered before `app.use("/api/*", rateLimitMiddleware)` at `index.ts:67` specifically so health checks stay unrate-limited) — not a novel or isolated workaround, but the established precedent for this exact ordering trick. Because mounting ahead of the global `logger()` also drops that request logging, the route file adds its own router-scoped `feedbackPublicRouter.use("*", logger())` so submit requests are still logged.
- Rate-limit dual-keying uses **dedicated** env vars — `RATE_LIMIT_FEEDBACK_MAX` (default 30, token-hash key) and `RATE_LIMIT_FEEDBACK_IP_MAX` (default 100, IP key) — reusing only the existing `RATE_LIMIT_WINDOW_SECS` (default 60). These are new fields added to `packages/types/src/env.ts` in this task. They are deliberately separate from `RATE_LIMIT_API_MAX`/`RATE_LIMIT_AUTH_MAX`: this route runs outside the global `rateLimitMiddleware` chain entirely (mounted before it, same as above), so reusing those authenticated-traffic limits would let anonymous feedback-spam share a budget with legitimate authenticated callers.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/feedback.test.ts` (add this import at the top of the file, keeping the existing imports):

```ts
import { hashFeedbackToken } from "../services/feedback";
```

```ts
async function mintSource(
	f: { projectId: string; token: string; slug: string },
	body: Record<string, unknown> = { name: "Widget" }
): Promise<string> {
	const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { token: string }).token;
}

describe("Feedback submit (public)", () => {
	it("accepts a body-only submission and returns { id } only", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Love it" }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(data)).toEqual(["id"]);

		const row = await env.DB.prepare(
			"SELECT project_id, workspace_id, source_id, status FROM feedback WHERE id = ?"
		)
			.bind(data.id)
			.first<{ project_id: string; workspace_id: string; source_id: string; status: string }>();
		expect(row?.project_id).toBe(f.projectId);
		expect(row?.status).toBe("new");
	});

	it("resolves project/workspace from the source, ignoring body-supplied ids", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x", projectId: "00000000-0000-0000-0000-000000000000" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		const row = await env.DB.prepare("SELECT project_id FROM feedback WHERE id = ?")
			.bind(id)
			.first<{ project_id: string }>();
		expect(row?.project_id).toBe(f.projectId);
	});

	it("rejects an unknown token with 401", async () => {
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects a revoked source with 401", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const list = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		const [{ id }] = (await list.json()) as Array<{ id: string }>;
		await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`, {
			method: "DELETE",
			headers: authHeaders(f.token, f.slug),
		});
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects an inactive source with 403", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const list = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		const [{ id }] = (await list.json()) as Array<{ id: string }>;
		await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`, {
			method: "PATCH",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ isActive: false }),
		});
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(403);
	});

	it("400s an empty submission (neither rating nor body)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("sets Access-Control-Allow-Origin only for a listed origin", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f, { name: "W", allowedOrigins: ["https://acme.test"] });

		const allowed = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Origin: "https://acme.test",
			},
			body: JSON.stringify({ body: "x" }),
		});
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.test");

		const other = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Origin: "https://evil.test",
			},
			body: JSON.stringify({ body: "x" }),
		});
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("answers OPTIONS preflight with 204 and permissive CORS headers", async () => {
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "OPTIONS",
			headers: { Origin: "https://acme.test", "Access-Control-Request-Method": "POST" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.test");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});

	it("429s once the per-token limit (RATE_LIMIT_FEEDBACK_MAX) is exceeded", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const tokenHash = await hashFeedbackToken(token);
		const slot = Math.floor(Date.now() / 1000 / 60) * 60; // RATE_LIMIT_WINDOW_SECS=60
		// RATE_LIMIT_FEEDBACK_MAX=5 in wrangler.test.toml — seed straight to the limit.
		await env.DB.prepare(
			"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, 5, ?)"
		)
			.bind(`feedback:${tokenHash}`, slot)
			.run();

		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(429);
	});

	it("429s once the per-IP limit (RATE_LIMIT_FEEDBACK_IP_MAX) is exceeded", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const slot = Math.floor(Date.now() / 1000 / 60) * 60; // RATE_LIMIT_WINDOW_SECS=60
		// RATE_LIMIT_FEEDBACK_IP_MAX=5 in wrangler.test.toml — no CF-Connecting-IP
		// header in tests, so the middleware falls back to the fixed '127.0.0.1' key.
		await env.DB.prepare(
			"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, 5, ?)"
		)
			.bind("feedback-ip:127.0.0.1", slot)
			.run();

		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(429);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — `/api/feedback/submit` unmounted (404/401 mismatches), no service module, `RATE_LIMIT_FEEDBACK_MAX`/`RATE_LIMIT_FEEDBACK_IP_MAX` unknown on `Env`.

- [ ] **Step 3: Add the dedicated rate-limit env vars**

In `packages/types/src/env.ts`, add two fields to the `Env` interface, next to the existing `RATE_LIMIT_*` fields:

```ts
	RATE_LIMIT_AUTH_FAIL_MAX?: string; // max failed bearer-token auths per IP per window before 429 (default 50)
	// PROJ-378: public feedback-submit rate limiting. Dedicated from RATE_LIMIT_API_MAX/
	// RATE_LIMIT_AUTH_MAX (which govern authenticated API/auth traffic) because the
	// submit route runs outside the global rateLimitMiddleware chain entirely and
	// anonymous feedback-spam must not share a budget with authenticated callers.
	RATE_LIMIT_FEEDBACK_MAX?: string; // max submissions per source token per window (default 30)
	RATE_LIMIT_FEEDBACK_IP_MAX?: string; // max submissions per IP per window (default 100)
```

In `apps/api/wrangler.test.toml`, add two low test values next to the existing rate-limit vars so the 429 tests above (which seed `rate_limit` directly to the limit) use the same fixed value the middleware reads:

```toml
RATE_LIMIT_AUTH_FAIL_MAX = "3"
# PROJ-378 public feedback submit — low so the 429 tests can seed straight to the limit.
RATE_LIMIT_FEEDBACK_MAX = "5"
RATE_LIMIT_FEEDBACK_IP_MAX = "5"
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/services/feedback.ts`:

```ts
import { SubmitFeedbackSchema } from "../schemas/feedback";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";

export async function hashFeedbackToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

interface SubmitSourceRow {
	id: string;
	workspace_id: string;
	project_id: string;
	is_active: number;
	allowed_origins: string | null;
	revoked_at: number | null;
}

export async function submitFeedback(
	db: D1Database,
	token: string,
	rawBody: unknown,
	requestOrigin: string | null
): Promise<{ id: string; corsAllowOrigin: string | null }> {
	const tokenHash = await hashFeedbackToken(token);
	const source = await db
		.prepare(
			`SELECT id, workspace_id, project_id, is_active, allowed_origins, revoked_at
       FROM feedback_sources WHERE token_hash = ?`
		)
		.bind(tokenHash)
		.first<SubmitSourceRow>();

	// Unknown or revoked → treated as an invalid credential (route maps NotFound → 401).
	if (!source || source.revoked_at !== null) throw new NotFoundError("Invalid feedback token");
	// Inactive → the credential is real but the source is paused (kill switch) → 403.
	if (source.is_active !== 1) throw new ForbiddenError("Feedback source is inactive");

	const parsed = SubmitFeedbackSchema.safeParse(rawBody);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const d = parsed.data;

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			`INSERT INTO feedback
       (id, source_id, workspace_id, project_id, rating, rating_scale, body, submitter_label, source_url, app_version, status, linked_issue_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?)`
		)
		.bind(
			id,
			source.id,
			source.workspace_id,
			source.project_id,
			d.rating ?? null,
			d.ratingScale ?? null,
			d.body ?? null,
			d.submitterLabel ?? null,
			d.sourceUrl ?? null,
			d.appVersion ?? null,
			now
		)
		.run();

	const allowed = source.allowed_origins
		? (JSON.parse(source.allowed_origins) as string[])
		: null;
	const corsAllowOrigin =
		allowed && requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : null;

	return { id, corsAllowOrigin };
}
```

- [ ] **Step 5: Write the public router**

Create `apps/api/src/routes/feedback.ts`:

```ts
import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { ForbiddenError, NotFoundError, ValidationError } from "../services/errors";
import { hashFeedbackToken, submitFeedback } from "../services/feedback";
import { bumpRateCounter } from "../middleware/rate-limit";

const publicRouter = new Hono<HonoEnv>();

// PROJ-378: this router is mounted ahead of the global app.use("*", logger())
// in index.ts (see Step 6 below), so it needs its own logging or submit
// requests go unlogged entirely.
publicRouter.use("*", logger());

// Anonymous end-user feedback preflight. We cannot know the source (no token on a
// preflight), so reflect the requesting Origin; the POST response is what actually
// enforces the per-source allow-list.
publicRouter.options("/submit", (c) => {
	const origin = c.req.header("Origin");
	const headers: Record<string, string> = {
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "86400",
	};
	if (origin) headers["Access-Control-Allow-Origin"] = origin;
	return c.body(null, 204, headers);
});

publicRouter.post("/submit", async (c) => {
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
	const token = auth.slice(7);
	const origin = c.req.header("Origin") ?? null;

	// Dual-keyed rate limit (token hash + IP) — reject if either trips its bucket.
	// Dedicated PROJ-378 env vars, not RATE_LIMIT_API_MAX/RATE_LIMIT_AUTH_MAX: this
	// route runs outside the global rateLimitMiddleware chain (mounted before it),
	// and anonymous feedback traffic must not share a budget with authenticated callers.
	const windowSecs = parseInt(c.env.RATE_LIMIT_WINDOW_SECS ?? "60", 10);
	const tokenLimit = parseInt(c.env.RATE_LIMIT_FEEDBACK_MAX ?? "30", 10);
	const ipLimit = parseInt(c.env.RATE_LIMIT_FEEDBACK_IP_MAX ?? "100", 10);
	const ip = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
	const tokenHash = await hashFeedbackToken(token);
	const tokenCount = await bumpRateCounter(c.env.DB, `feedback:${tokenHash}`, windowSecs);
	const ipCount = await bumpRateCounter(c.env.DB, `feedback-ip:${ip}`, windowSecs);
	if (tokenCount > tokenLimit || ipCount > ipLimit) {
		return c.json({ error: "Too Many Requests" }, 429);
	}

	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		rawBody = {};
	}

	try {
		const { id, corsAllowOrigin } = await submitFeedback(c.env.DB, token, rawBody, origin);
		if (corsAllowOrigin) c.header("Access-Control-Allow-Origin", corsAllowOrigin);
		return c.json({ id }, 201);
	} catch (e) {
		// Endpoint-specific mapping: an unknown/revoked source is an invalid
		// credential (401), an inactive source is a paused resource (403), a bad
		// body is 400. (NotFound → 401 here, unlike every other endpoint.)
		if (e instanceof ValidationError) return c.json({ error: e.issues }, 400);
		if (e instanceof ForbiddenError) return c.json({ error: e.message }, 403);
		if (e instanceof NotFoundError) return c.json({ error: e.message }, 401);
		throw e;
	}
});

export { publicRouter as feedbackPublicRouter };
```

- [ ] **Step 6: Mount the public router before global logger/cors**

In `apps/api/src/index.ts`, add the import (with the other route imports):

```ts
import { feedbackPublicRouter } from "./routes/feedback";
```

Then mount it as the **first** route registration, immediately after `const app = new Hono<HonoEnv>();` and BEFORE `app.use("*", logger());`:

```ts
const app = new Hono<HonoEnv>();

// PROJ-378: anonymous feedback ingestion. Mounted ahead of the global logger()
// and cors() calls below — not merely ahead of auth — the same "register before
// the .use() you need to skip" technique already used for /api/health (mounted
// ahead of the /api/* rateLimitMiddleware .use() further down so health checks
// stay unrate-limited). The global cors() is an allowlist that by design excludes
// third-party feedback origins and would otherwise short-circuit the OPTIONS
// preflight; the route verifies the source's own token inline and owns its
// per-source CORS instead. It also loses the global logger() this way, so
// feedbackPublicRouter applies its own scoped logger() (see routes/feedback.ts).
app.route("/api/feedback", feedbackPublicRouter);

app.use("*", logger());
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS (the 10 "Feedback submit (public)" tests + prior tests).

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/env.ts apps/api/wrangler.test.toml apps/api/src/services/feedback.ts apps/api/src/routes/feedback.ts apps/api/src/index.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): public submit endpoint with per-source CORS + dedicated dual-key rate limit (PROJ-378)"
```

---

## Task 5: Triage read/patch — `listFeedback` + `updateFeedbackStatus`

**Files:**
- Modify: `apps/api/src/services/feedback.ts` (add two functions)
- Create: `apps/api/src/routes/feedback.ts` → add an authed router (same file, new export)
- Modify: `apps/api/src/index.ts` (mount authed feedback router)
- Test: `apps/api/src/test/feedback.test.ts`

**Interfaces:**
- Consumes: `requireProjectAccess`, `canWriteProject` (`services/access.ts`); `ListFeedbackSchema`, `UpdateFeedbackSchema`.
- Produces (exported from `services/feedback.ts`):
  - `listFeedback(ctx: ServiceCtx, input: unknown): Promise<FeedbackView[]>` where `FeedbackView = { id, sourceId, sourceName, rating, ratingScale, body, submitterLabel, sourceUrl, appVersion, status, linkedIssueId, createdAt }`
  - `updateFeedbackStatus(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }>`
  - Authed REST: `GET /api/projects/:id/feedback`, `PATCH /api/projects/:id/feedback/:feedbackId`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/feedback.test.ts`:

```ts
async function seedFeedbackRow(
	sourceId: string,
	workspaceId: string,
	projectId: string,
	opts: { body?: string; status?: string } = {}
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO feedback (id, source_id, workspace_id, project_id, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(id, sourceId, workspaceId, projectId, opts.body ?? "seed", opts.status ?? "new", now)
		.run();
	return id;
}

describe("Feedback triage read/patch", () => {
	it("GET lists feedback with the source name, filtered by status", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f, { name: "Onboarding" });
		const src = await env.DB.prepare(
			"SELECT id FROM feedback_sources WHERE project_id = ?"
		)
			.bind(f.projectId)
			.first<{ id: string }>();
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, { status: "new", body: "a" });
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, { status: "reviewed", body: "b" });

		const all = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback`, {
			headers: authHeaders(f.token, f.slug),
		});
		const allRows = (await all.json()) as Array<{ sourceName: string; status: string }>;
		expect(allRows).toHaveLength(2);
		expect(allRows[0].sourceName).toBe("Onboarding");

		const filtered = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback?status=new`,
			{ headers: authHeaders(f.token, f.slug) }
		);
		const rows = (await filtered.json()) as Array<{ status: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("new");
	});

	it("GET 404s for a caller with no project access", async () => {
		const owner = await seedProjectFixture({ role: "owner" });
		await mintSource(owner);
		const stranger = await seedProjectFixture({ role: "owner" }); // different workspace
		const res = await SELF.fetch(`http://localhost/api/projects/${owner.projectId}/feedback`, {
			headers: authHeaders(stranger.token, stranger.slug),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH updates status for member+, 403 for viewer", async () => {
		const roles = await seedWorkspaceRoles();
		const proj = await seedProject(roles.workspace.id, "TRI");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, proj.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, proj.id, "viewer");
		const create = await SELF.fetch(`http://localhost/api/projects/${proj.id}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ name: "S" }),
		});
		await create.json();
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(proj.id)
			.first<{ id: string }>();
		const fbId = await seedFeedbackRow(src!.id, roles.workspace.id, proj.id);

		const viewerRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback/${fbId}`,
			{
				method: "PATCH",
				headers: authHeaders(roles.viewer.token, roles.workspace.slug),
				body: JSON.stringify({ status: "reviewed" }),
			}
		);
		expect(viewerRes.status).toBe(403);

		const memberRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback/${fbId}`,
			{
				method: "PATCH",
				headers: authHeaders(roles.member.token, roles.workspace.slug),
				body: JSON.stringify({ status: "reviewed" }),
			}
		);
		expect(memberRes.status).toBe(200);
		const row = await env.DB.prepare("SELECT status FROM feedback WHERE id = ?")
			.bind(fbId)
			.first<{ status: string }>();
		expect(row?.status).toBe("reviewed");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — GET/PATCH feedback routes unmounted.

- [ ] **Step 3: Add the service functions**

Append to `apps/api/src/services/feedback.ts`. First extend the imports at the top of the file:

```ts
import { ListFeedbackSchema, SubmitFeedbackSchema, UpdateFeedbackSchema } from "../schemas/feedback";
import { canWriteProject, requireProjectAccess } from "./access";
import type { ServiceCtx } from "./types";
```

(Replace the existing single `import { SubmitFeedbackSchema } ...` line with the combined import above, and add the `access`/`types` imports.)

Then append these functions:

```ts
export interface FeedbackView {
	id: string;
	sourceId: string;
	sourceName: string | null;
	rating: number | null;
	ratingScale: string | null;
	body: string | null;
	submitterLabel: string | null;
	sourceUrl: string | null;
	appVersion: string | null;
	status: string;
	linkedIssueId: string | null;
	createdAt: number;
}

interface FeedbackJoinRow {
	id: string;
	source_id: string;
	source_name: string | null;
	rating: number | null;
	rating_scale: string | null;
	body: string | null;
	submitter_label: string | null;
	source_url: string | null;
	app_version: string | null;
	status: string;
	linked_issue_id: string | null;
	created_at: number;
}

export async function listFeedback(ctx: ServiceCtx, input: unknown): Promise<FeedbackView[]> {
	const parsed = ListFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, status, sourceId } = parsed.data;

	await requireProjectAccess(ctx, projectId);

	const clauses = ["f.project_id = ?", "f.workspace_id = ?"];
	const binds: unknown[] = [projectId, ctx.workspaceId];
	if (status) {
		clauses.push("f.status = ?");
		binds.push(status);
	}
	if (sourceId) {
		clauses.push("f.source_id = ?");
		binds.push(sourceId);
	}

	const { results } = await ctx.db
		.prepare(
			`SELECT f.id, f.source_id, s.name AS source_name, f.rating, f.rating_scale, f.body,
              f.submitter_label, f.source_url, f.app_version, f.status, f.linked_issue_id, f.created_at
       FROM feedback f
       LEFT JOIN feedback_sources s ON s.id = f.source_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY f.created_at DESC`
		)
		.bind(...binds)
		.all<FeedbackJoinRow>();

	return (results ?? []).map((r) => ({
		id: r.id,
		sourceId: r.source_id,
		sourceName: r.source_name,
		rating: r.rating,
		ratingScale: r.rating_scale,
		body: r.body,
		submitterLabel: r.submitter_label,
		sourceUrl: r.source_url,
		appVersion: r.app_version,
		status: r.status,
		linkedIssueId: r.linked_issue_id,
		createdAt: r.created_at,
	}));
}

export async function updateFeedbackStatus(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ ok: true }> {
	const parsed = UpdateFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackId, status } = parsed.data;

	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	const row = await ctx.db
		.prepare("SELECT id FROM feedback WHERE id = ? AND project_id = ? AND workspace_id = ?")
		.bind(feedbackId, projectId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!row) throw new NotFoundError("Feedback not found");

	await ctx.db
		.prepare("UPDATE feedback SET status = ? WHERE id = ? AND workspace_id = ?")
		.bind(status, feedbackId, ctx.workspaceId)
		.run();

	return { ok: true };
}
```

- [ ] **Step 4: Add the authed router**

Append to `apps/api/src/routes/feedback.ts` (add imports for the new service functions + `ctxFromHono` + `serviceErrToResponse`, then a new router export):

```ts
import { serviceErrToResponse } from "../http/error-adapter";
import { listFeedback, updateFeedbackStatus } from "../services/feedback";
import { ctxFromHono } from "../services/types";

const authedRouter = new Hono<HonoEnv>();

authedRouter.get("/:id/feedback", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const status = c.req.query("status");
	const sourceId = c.req.query("sourceId");
	try {
		return c.json(await listFeedback(ctx, { projectId, status, sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

authedRouter.patch("/:id/feedback/:feedbackId", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const feedbackId = c.req.param("feedbackId");
	const raw = await c.req.json();
	try {
		return c.json(await updateFeedbackStatus(ctx, { projectId, feedbackId, ...raw }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { authedRouter as feedbackRouter };
```

(`listFeedback`/`updateFeedbackStatus` pass `undefined` for absent query params — the Zod schema treats missing `status`/`sourceId` as optional; `c.req.query` returns `undefined` when absent, which is fine.)

- [ ] **Step 5: Mount the authed router**

In `apps/api/src/index.ts`, extend the feedback import and mount in the authed block next to `feedbackSourcesRouter`:

```ts
import { feedbackRouter } from "./routes/feedback";
```

```ts
app.route("/api/projects", feedbackSourcesRouter);
app.route("/api/projects", feedbackRouter);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS (the 3 "Feedback triage read/patch" tests + prior).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/feedback.ts apps/api/src/routes/feedback.ts apps/api/src/index.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): triage list + status patch routes (PROJ-378)"
```

---

## Task 6: Convert-to-issue

**Files:**
- Modify: `apps/api/src/services/feedback.ts` (add `convertFeedbackToIssue`)
- Modify: `apps/api/src/routes/feedback.ts` (add POST convert route to `authedRouter`)
- Test: `apps/api/src/test/feedback.test.ts`

**Interfaces:**
- Consumes: `createIssue(ctx, raw): Promise<{ id: string; number?: number }>` (`services/issues.ts`); `ConvertFeedbackSchema`; `requireProjectAccess`/`canWriteProject`.
- Produces: `convertFeedbackToIssue(ctx: ServiceCtx, input: unknown): Promise<{ id: string; number?: number }>`; REST `POST /api/projects/:id/feedback/:feedbackId/convert-to-issue`.

**Note:** the title-truncation length (120) and body-footer wording are the design doc's flagged judgement-call defaults — keep them verbatim here; a human confirms wording before release.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/feedback.test.ts`:

```ts
describe("Feedback convert-to-issue", () => {
	it("creates an issue, links it, marks feedback actioned (member+)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();
		const fbId = await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, {
			body: "The export button is broken",
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/${fbId}/convert-to-issue`,
			{ method: "POST", headers: authHeaders(f.token, f.slug) }
		);
		expect(res.status).toBe(201);
		const issue = (await res.json()) as { id: string };
		expect(issue.id).toBeTruthy();

		const row = await env.DB.prepare(
			"SELECT status, linked_issue_id FROM feedback WHERE id = ?"
		)
			.bind(fbId)
			.first<{ status: string; linked_issue_id: string | null }>();
		expect(row?.status).toBe("actioned");
		expect(row?.linked_issue_id).toBe(issue.id);
	});

	it("403s for a viewer", async () => {
		const roles = await seedWorkspaceRoles();
		const proj = await seedProject(roles.workspace.id, "CVT");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, proj.id, "viewer");
		const create = await SELF.fetch(`http://localhost/api/projects/${proj.id}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ name: "S" }),
		});
		await create.json();
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(proj.id)
			.first<{ id: string }>();
		const fbId = await seedFeedbackRow(src!.id, roles.workspace.id, proj.id);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback/${fbId}/convert-to-issue`,
			{ method: "POST", headers: authHeaders(roles.viewer.token, roles.workspace.slug) }
		);
		expect(res.status).toBe(403);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — convert route unmounted / function missing.

- [ ] **Step 3: Add the service function**

In `apps/api/src/services/feedback.ts`, extend the schema import to include `ConvertFeedbackSchema`, and add `import { createIssue } from "./issues";` near the top. Then append:

```ts
function ratingLabel(rating: number | null, scale: string | null): string {
	if (rating === null) return "Rating";
	if (scale === "thumbs") return rating > 0 ? "👍 Positive" : "👎 Negative";
	return `${rating}★`;
}

interface ConvertFeedbackRow {
	rating: number | null;
	rating_scale: string | null;
	body: string | null;
	submitter_label: string | null;
}

export async function convertFeedbackToIssue(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; number?: number }> {
	const parsed = ConvertFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackId } = parsed.data;

	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	const fb = await ctx.db
		.prepare(
			`SELECT rating, rating_scale, body, submitter_label
       FROM feedback WHERE id = ? AND project_id = ? AND workspace_id = ?`
		)
		.bind(feedbackId, projectId, ctx.workspaceId)
		.first<ConvertFeedbackRow>();
	if (!fb) throw new NotFoundError("Feedback not found");

	const title = fb.body
		? fb.body.slice(0, 120)
		: `${ratingLabel(fb.rating, fb.rating_scale)} feedback`;
	const footer =
		`— submitted via feedback source${fb.submitter_label ? ` by ${fb.submitter_label}` : ""}` +
		(fb.rating !== null ? `, rating: ${fb.rating} (${fb.rating_scale})` : "");

	const issue = await createIssue(ctx, {
		projectId,
		title,
		body: [fb.body ?? "", "", footer].join("\n"),
		priority: "medium",
	});

	await ctx.db
		.prepare(
			"UPDATE feedback SET linked_issue_id = ?, status = 'actioned' WHERE id = ? AND workspace_id = ?"
		)
		.bind(issue.id, feedbackId, ctx.workspaceId)
		.run();

	return issue;
}
```

- [ ] **Step 4: Add the convert route**

In `apps/api/src/routes/feedback.ts`, add `convertFeedbackToIssue` to the service import and append to `authedRouter` (before its `export`):

```ts
authedRouter.post("/:id/feedback/:feedbackId/convert-to-issue", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const feedbackId = c.req.param("feedbackId");
	try {
		return c.json(await convertFeedbackToIssue(ctx, { projectId, feedbackId }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS (both convert tests + prior).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/feedback.ts apps/api/src/routes/feedback.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): convert-to-issue reusing createIssue (PROJ-378)"
```

---

## Task 7: MCP source-management tools

**Files:**
- Create: `apps/api/src/mcp/feedback.ts`
- Modify: `apps/api/src/routes/mcp.ts` (compose `feedbackTools`)
- Test: `apps/api/src/test/feedback.test.ts`

**Interfaces:**
- Consumes: the five `services/feedback-sources.ts` functions (Task 3); `MCPTool` type; `ServiceCtx`.
- Produces: `feedbackTools: MCPTool[]` with tools `create_feedback_source`, `list_feedback_sources`, `update_feedback_source`, `rotate_feedback_source_token`, `revoke_feedback_source`. No `submit_feedback` tool (deliberate asymmetry).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/feedback.test.ts` (reuse the `mcpCall` helper — copy the same helper + JSON-RPC types used in `comments.test.ts` into the top of this file if not already present):

```ts
type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

async function mcpCall<T>(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	return res.json();
}

function mcpText<T>(r: JsonRpcResult<{ content: Array<{ text: string }> }>): T {
	return JSON.parse(r.result.content[0].text) as T;
}

describe("Feedback source MCP tools", () => {
	it("create_feedback_source returns a one-time token (owner)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			f.workspaceId,
			"create_feedback_source",
			{ projectId: f.projectId, name: "Onboarding" },
			authHeaders(f.token, f.slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const out = mcpText<{ id: string; token: string }>(res);
		expect(out.id).toBeTruthy();
		expect(out.token).toBeTruthy();
	});

	it("create_feedback_source is forbidden for a member (-32000)", async () => {
		const f = await seedProjectFixture({ role: "member" });
		const res = (await mcpCall(
			f.workspaceId,
			"create_feedback_source",
			{ projectId: f.projectId, name: "X" },
			authHeaders(f.token, f.slug)
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
		expect(res.error.code).toBe(-32000);
	});

	it("list_feedback_sources never leaks a raw token", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = (await mcpCall<{ content: Array<{ text: string }> }>(
			f.workspaceId,
			"create_feedback_source",
			{ projectId: f.projectId, name: "NPS" },
			authHeaders(f.token, f.slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { token } = mcpText<{ id: string; token: string }>(created);

		const listed = (await mcpCall<{ content: Array<{ text: string }> }>(
			f.workspaceId,
			"list_feedback_sources",
			{ projectId: f.projectId },
			authHeaders(f.token, f.slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		expect(listed.result.content[0].text).not.toContain(token);
	});

	it("rotate_feedback_source_token invalidates the old token, keeps id + history", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = (await mcpCall<{ content: Array<{ text: string }> }>(
			f.workspaceId,
			"create_feedback_source",
			{ projectId: f.projectId, name: "R" },
			authHeaders(f.token, f.slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { id, token: oldToken } = mcpText<{ id: string; token: string }>(created);
		// Existing feedback under this source
		const fbId = await seedFeedbackRow(id, f.workspaceId, f.projectId, { body: "keep me" });

		const rotated = (await mcpCall<{ content: Array<{ text: string }> }>(
			f.workspaceId,
			"rotate_feedback_source_token",
			{ sourceId: id },
			authHeaders(f.token, f.slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { token: newToken } = mcpText<{ token: string }>(rotated);
		expect(newToken).not.toBe(oldToken);

		// Old token now rejected
		const oldRes = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(oldRes.status).toBe(401);
		// New token works
		const newRes = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${newToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "y" }),
		});
		expect(newRes.status).toBe(201);
		// id + history intact
		const stillThere = await env.DB.prepare("SELECT id FROM feedback WHERE id = ? AND source_id = ?")
			.bind(fbId, id)
			.first<{ id: string }>();
		expect(stillThere?.id).toBe(fbId);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback`
Expected: FAIL — `Tool not found: create_feedback_source`.

- [ ] **Step 3: Write the MCP tools**

Create `apps/api/src/mcp/feedback.ts`:

```ts
import type { MCPTool } from "@projektor/types";
import {
	createFeedbackSource,
	listFeedbackSources,
	revokeFeedbackSource,
	rotateFeedbackSourceToken,
	updateFeedbackSource,
} from "../services/feedback-sources";
import type { ServiceCtx } from "../services/types";

export const feedbackTools: MCPTool[] = [
	{
		name: "create_feedback_source",
		description:
			"Create a feedback source for a project. A source is a named collection point " +
			"(e.g. 'Onboarding survey', 'In-app NPS widget') that end-user feedback is submitted " +
			"against. Returns a raw token that must be embedded in the user's own product code (a " +
			"form or widget that POSTs to /api/feedback/submit with 'Authorization: Bearer <token>'). " +
			"The raw token is shown exactly once and cannot be retrieved later — relay it to the user " +
			"immediately. Admin/owner only. Optionally restrict browser callers with allowedOrigins " +
			"(a list of allowed CORS origins); omit it for server-to-server callers.",
		inputSchema: {
			type: "object",
			required: ["projectId", "name"],
			properties: {
				projectId: { type: "string", description: "UUID of the project this source belongs to" },
				name: { type: "string", minLength: 1, maxLength: 100 },
				description: { type: "string", maxLength: 500 },
				allowedOrigins: {
					type: "array",
					items: { type: "string", maxLength: 2000 },
					description: "Allowed CORS origins for browser submission; omit for no restriction",
				},
			},
		},
		async handler(input, ctx) {
			return createFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "list_feedback_sources",
		description:
			"List a project's feedback sources. Each entry includes id, name, description, whether " +
			"it is active, its allowed origins, a truncated token preview (never the raw token), and " +
			"created/revoked timestamps. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: { projectId: { type: "string" } },
		},
		async handler(input, ctx) {
			return listFeedbackSources(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "update_feedback_source",
		description:
			"Update a feedback source's name, description, or active state. Setting isActive to false " +
			"is a kill switch: submissions against the source's token are immediately rejected (this is " +
			"reversible — set it back to true to resume; contrast with revoke_feedback_source, which is " +
			"permanent). Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: {
				sourceId: { type: "string" },
				name: { type: "string", minLength: 1, maxLength: 100 },
				description: { type: "string", maxLength: 500 },
				isActive: { type: "boolean" },
			},
		},
		async handler(input, ctx) {
			return updateFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "rotate_feedback_source_token",
		description:
			"Generate a new token for a feedback source. Returns the new raw token once; the old token " +
			"stops working immediately. The source's identity (id), name, description, and all its " +
			"historical feedback are preserved — use this when a token has leaked or needs periodic " +
			"rotation. Relay the new token to the user so they can update their product code. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: { sourceId: { type: "string" } },
		},
		async handler(input, ctx) {
			return rotateFeedbackSourceToken(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "revoke_feedback_source",
		description:
			"Permanently revoke a feedback source. Its token stops working for good and it can never " +
			"accept another submission (its historical feedback is retained for reference). To replace " +
			"a revoked source, create a new one. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: { sourceId: { type: "string" } },
		},
		async handler(input, ctx) {
			return revokeFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
];
```

- [ ] **Step 4: Compose into the MCP router**

In `apps/api/src/routes/mcp.ts`, add the import (alphabetically among the `../mcp/*` imports):

```ts
import { feedbackTools } from "../mcp/feedback";
```

and add `...feedbackTools,` to the `coreMCPTools` array (e.g. after `...commentsTools,`):

```ts
	...commentsTools,
	...feedbackTools,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback`
Expected: PASS (the 4 MCP tests + prior).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/mcp/feedback.ts apps/api/src/routes/mcp.ts apps/api/src/test/feedback.test.ts
git commit -m "feat(feedback): MCP source-management tools (PROJ-378)"
```

---

## Task 8: Web — Feedback nav tab + page

**Files:**
- Modify: `apps/web/src/islands/ProjectNav.tsx` (add the tab)
- Create: `apps/web/src/pages/feedback.astro`
- Test: `apps/web/src/islands/ProjectNav.test.tsx` (add one assertion)

**Interfaces:**
- Consumes: existing `ProjectNav` `TABS`/href-switch machinery.
- Produces: a "Feedback" tab linking to `/feedback?projectId=<id>`; a `/feedback` page mounting `ProjectNav` + the two islands (islands added in Tasks 9-10 — the page imports them, so create the island files as empty default-export stubs here if needed, OR sequence this task after 9-10; recommended: keep this task's page referencing the islands and land it together with 9-10. For independent testability, this task ships only the tab + an island-less page shell, and Tasks 9-10 add the island mounts.)

**Decision:** This task ships the tab + a page shell that mounts only `ProjectNav`. Tasks 9 and 10 each add their island mount to the page. That keeps every task independently testable.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/islands/ProjectNav.test.tsx` (append an assertion inside the existing describe, matching the file's established mock-fetch pattern — mock a project fetch, render, assert the Feedback tab href):

```tsx
it("renders a Feedback tab linking to /feedback?projectId", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("/api/projects/")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ id: "p1", key: "PROJ", name: "Proj", slug: null }),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		})
	);
	window.history.pushState({}, "", "/metrics?projectId=p1");
	render(<ProjectNav workspaceSlug="my-ws" />);
	const link = (await screen.findByText("Feedback")) as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe("/feedback?projectId=p1");
});
```

(Match the existing imports/setup in `ProjectNav.test.tsx`; if it already stubs fetch in a `beforeEach`, reuse that instead of re-stubbing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test ProjectNav`
Expected: FAIL — no "Feedback" tab found.

- [ ] **Step 3: Add the tab**

In `apps/web/src/islands/ProjectNav.tsx`, add one entry to the module-level `TABS` array (after Metrics):

```tsx
const TABS = [
	{ label: "Overview", path: "/projects/view" },
	{ label: "Issues", path: "/issues" },
	{ label: "Wiki", path: "/wiki" },
	{ label: "Sprints", path: "/sprints" },
	{ label: "Epics", path: "/epics" },
	{ label: "Metrics", path: "/metrics" },
	{ label: "Feedback", path: "/feedback" },
];
```

No href-switch change is needed: the `default` case already produces `${t.path}?projectId=<id>`, i.e. `/feedback?projectId=<id>`.

- [ ] **Step 4: Create the page shell**

Create `apps/web/src/pages/feedback.astro`:

```astro
---
import Base from '../layouts/Base.astro';
import ProjectNav from '../islands/ProjectNav';
---
<Base title="Feedback — Projektor">
  <ProjectNav client:load workspaceSlug={import.meta.env.PUBLIC_WORKSPACE_SLUG} pageLabel="Feedback" />
  <div class="page-container">
    <!-- FeedbackSourceManager (Task 9) and FeedbackList (Task 10) mounts added here -->
  </div>
</Base>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test ProjectNav`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/ProjectNav.tsx apps/web/src/pages/feedback.astro apps/web/src/islands/ProjectNav.test.tsx
git commit -m "feat(web): add Feedback nav tab + page shell (PROJ-378)"
```

---

## Task 9: Web — Feedback source manager island

**Files:**
- Create: `apps/web/src/islands/FeedbackSourceManager.tsx`
- Create: `apps/web/src/islands/FeedbackSourceManager.test.tsx`
- Modify: `apps/web/src/pages/feedback.astro` (mount the island)

**Interfaces:**
- Consumes: `apiFetch` (`utils/api-client.ts`); REST routes from Tasks 3 (`/api/projects/:id/feedback-sources` + `/rotate`).
- Produces: default-exported `FeedbackSourceManager({ workspaceSlug?, projectId })` island.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/islands/FeedbackSourceManager.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceManager from "./FeedbackSourceManager";

const SOURCE = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

function stubFetch(sources = [SOURCE]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/feedback-sources") && (init?.method ?? "GET") === "GET") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			if (u.includes("/feedback-sources") && init?.method === "POST") {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ id: "s2", token: "fbk_rawtoken_shown_once" }),
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		})
	);
}

describe("FeedbackSourceManager", () => {
	it("lists sources with name and token preview after fetch", async () => {
		stubFetch();
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Onboarding survey")).toBeTruthy();
		expect(screen.getByText(/abcdef012345/)).toBeTruthy();
	});

	it("shows the raw token once after minting a source", async () => {
		stubFetch([]);
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText(/No feedback sources yet/i);
		fireEvent.click(screen.getByRole("button", { name: /New source/i }));
		fireEvent.input(await screen.findByLabelText(/Name/i), { target: { value: "NPS" } });
		fireEvent.click(screen.getByRole("button", { name: /Create source/i }));
		expect(await screen.findByText("fbk_rawtoken_shown_once")).toBeTruthy();
		expect(screen.getByText(/won't be able to see it again/i)).toBeTruthy();
	});

	it("renders an access-denied notice on a 403 list response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() =>
				Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
			)
		);
		render(<FeedbackSourceManager workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText(/Only workspace owners and admins/i)).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test FeedbackSourceManager`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the island**

Create `apps/web/src/islands/FeedbackSourceManager.tsx`:

```tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface FeedbackSource {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

interface NewSourceResult {
	id: string;
	token: string;
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
}

const INPUT_CLASS =
	"px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";
const TD = "px-3 py-2 border-b border-border align-middle text-[0.875rem]";
const TH = "text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

function parseOrigins(raw: string): string[] | undefined {
	const list = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

export default function FeedbackSourceManager({ workspaceSlug, projectId }: Props) {
	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [showCreate, setShowCreate] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [origins, setOrigins] = useState("");
	const [creating, setCreating] = useState(false);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [rotateId, setRotateId] = useState<string | null>(null);

	const fetchSources = useCallback(async () => {
		setLoading(true);
		setError(null);
		setForbidden(false);
		try {
			const data = await apiFetch<FeedbackSource[]>(
				`/api/projects/${projectId}/feedback-sources`,
				{ workspaceSlug }
			);
			setSources(Array.isArray(data) ? data : []);
		} catch (e) {
			if (String(e).includes(": 403")) setForbidden(true);
			else setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, workspaceSlug]);

	useEffect(() => {
		fetchSources();
	}, [fetchSources]);

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;
		setCreating(true);
		try {
			const body: Record<string, unknown> = { name: name.trim() };
			if (description.trim()) body.description = description.trim();
			const parsed = parseOrigins(origins);
			if (parsed) body.allowedOrigins = parsed;
			const result = await apiFetch<NewSourceResult>(
				`/api/projects/${projectId}/feedback-sources`,
				{ method: "POST", workspaceSlug, body }
			);
			setNewToken(result.token);
			setName("");
			setDescription("");
			setOrigins("");
			await fetchSources();
		} catch (e) {
			setError(String(e));
		} finally {
			setCreating(false);
		}
	}

	async function toggleActive(s: FeedbackSource) {
		await apiFetch(`/api/projects/${projectId}/feedback-sources/${s.id}`, {
			method: "PATCH",
			workspaceSlug,
			body: { isActive: !s.isActive },
		});
		await fetchSources();
	}

	async function confirmRotate(id: string) {
		const result = await apiFetch<{ token: string }>(
			`/api/projects/${projectId}/feedback-sources/${id}/rotate`,
			{ method: "POST", workspaceSlug }
		);
		setRotateId(null);
		setNewToken(result.token);
		await fetchSources();
	}

	async function revoke(id: string) {
		await apiFetch(`/api/projects/${projectId}/feedback-sources/${id}`, {
			method: "DELETE",
			workspaceSlug,
		});
		await fetchSources();
	}

	if (loading) return <p aria-live="polite">Loading feedback sources…</p>;
	if (forbidden) {
		return (
			<div class="p-4 bg-surface border border-border rounded-md text-text-muted">
				<strong>Access denied.</strong> Only workspace owners and admins can manage feedback sources.
			</div>
		);
	}
	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load feedback sources: {error}
			</p>
		);
	}

	return (
		<section class="mb-8">
			<div class="flex justify-between items-center mb-4">
				<h3 class="m-0 text-base font-semibold text-text-base">Feedback sources</h3>
				{!showCreate && (
					<button type="button" class="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
						+ New source
					</button>
				)}
			</div>

			{newToken && (
				<div class="bg-surface border border-border rounded-md p-4 mb-4">
					<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
						⚠ Copy this token now — you won't be able to see it again.
					</p>
					<code class="block font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded break-all">
						{newToken}
					</code>
					<button
						type="button"
						class="btn btn-outline btn-sm mt-2"
						onClick={() => setNewToken(null)}
					>
						Done
					</button>
				</div>
			)}

			{showCreate && (
				<form onSubmit={handleCreate} class="mb-5 px-4 py-4 bg-surface border border-border rounded-lg">
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-name">
							Name *
						</label>
						<input
							id="fs-name"
							class={`w-full ${INPUT_CLASS}`}
							value={name}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							required
							maxLength={100}
						/>
					</div>
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-desc">
							Description
						</label>
						<input
							id="fs-desc"
							class={`w-full ${INPUT_CLASS}`}
							value={description}
							onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
							maxLength={500}
						/>
					</div>
					<div class="flex flex-col gap-1 mb-3">
						<label class="text-[0.8rem] font-semibold text-text-muted" for="fs-origins">
							Allowed origins (one per line, optional)
						</label>
						<textarea
							id="fs-origins"
							class={`w-full ${INPUT_CLASS}`}
							rows={2}
							value={origins}
							onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)}
						/>
					</div>
					<div class="flex gap-2">
						<button type="submit" class="btn btn-primary btn-sm" disabled={creating || !name.trim()}>
							{creating ? "Creating…" : "Create source"}
						</button>
						<button
							type="button"
							class="btn btn-outline btn-sm"
							onClick={() => setShowCreate(false)}
							disabled={creating}
						>
							Cancel
						</button>
					</div>
				</form>
			)}

			{sources.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback sources yet.
				</div>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr>
								<th class={TH}>Name</th>
								<th class={TH}>Description</th>
								<th class={TH}>Active</th>
								<th class={TH}>Token</th>
								<th class={TH}>Created</th>
								<th class={TH}></th>
							</tr>
						</thead>
						<tbody>
							{sources.map((s) => (
								<tr key={s.id}>
									<td class={`${TD} font-medium text-text-base`}>{s.name}</td>
									<td class={`${TD} text-text-muted`}>{s.description ?? "—"}</td>
									<td class={TD}>
										<button
											type="button"
											class="btn btn-outline btn-sm"
											onClick={() => toggleActive(s)}
										>
											{s.isActive ? "Active" : "Inactive"}
										</button>
									</td>
									<td class={`${TD} font-mono text-[0.8rem] text-text-muted`}>{s.tokenPreview}</td>
									<td class={`${TD} text-text-muted`}>{formatDate(s.createdAt)}</td>
									<td class={`${TD} whitespace-nowrap`}>
										{rotateId === s.id ? (
											<span class="inline-flex gap-[0.375rem] items-center">
												<span class="text-[0.8rem] text-text-muted">Rotate? Old token dies.</span>
												<button
													type="button"
													class="btn btn-danger btn-sm"
													onClick={() => confirmRotate(s.id)}
												>
													Yes
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => setRotateId(null)}
												>
													No
												</button>
											</span>
										) : (
											<span class="inline-flex gap-[0.375rem]">
												<button
													type="button"
													class="btn btn-outline btn-sm"
													onClick={() => setRotateId(s.id)}
												>
													Rotate
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm text-[var(--danger-text)] border-[var(--danger-border)]"
													onClick={() => revoke(s.id)}
												>
													Revoke
												</button>
											</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
```

- [ ] **Step 4: Mount on the page**

In `apps/web/src/pages/feedback.astro`, add the import and the mount (admin/owner gating is reactive — the island renders its own access-denied notice on a 403):

```astro
---
import Base from '../layouts/Base.astro';
import ProjectNav from '../islands/ProjectNav';
import FeedbackSourceManager from '../islands/FeedbackSourceManager';
---
<Base title="Feedback — Projektor">
  <ProjectNav client:load workspaceSlug={import.meta.env.PUBLIC_WORKSPACE_SLUG} pageLabel="Feedback" />
  <div class="page-container">
    <FeedbackSourceManager client:load workspaceSlug={import.meta.env.PUBLIC_WORKSPACE_SLUG} projectId={Astro.url.searchParams.get('projectId') ?? ''} />
  </div>
</Base>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test FeedbackSourceManager`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/FeedbackSourceManager.tsx apps/web/src/islands/FeedbackSourceManager.test.tsx apps/web/src/pages/feedback.astro
git commit -m "feat(web): feedback source manager island (PROJ-378)"
```

---

## Task 10: Web — Feedback triage list island

**Files:**
- Create: `apps/web/src/islands/FeedbackList.tsx`
- Create: `apps/web/src/islands/FeedbackList.test.tsx`
- Modify: `apps/web/src/pages/feedback.astro` (mount below the source manager)

**Interfaces:**
- Consumes: `apiFetch`; REST routes from Tasks 5-6 (`GET /feedback`, `POST .../convert-to-issue`).
- Produces: default-exported `FeedbackList({ workspaceSlug?, projectId })` island.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/islands/FeedbackList.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackList from "./FeedbackList";

const ROW = {
	id: "f1",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: 5,
	ratingScale: "five_star",
	body: "Great onboarding",
	submitterLabel: "a@b.com",
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1000,
};

function stubFetch(rows = [ROW]) {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/convert-to-issue")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "issue-1" }) });
		}
		if (u.includes("/feedback")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackList", () => {
	it("renders feedback rows with body and source name", async () => {
		stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Great onboarding")).toBeTruthy();
		expect(screen.getByText(/Onboarding survey/)).toBeTruthy();
	});

	it("changing the status filter refetches with the status query param", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "reviewed" } });
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => String(call[0]).includes("status=reviewed"))
			).toBe(true);
		});
	});

	it("convert-to-issue POSTs and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByRole("button", { name: /Convert to issue/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					(call) => String(call[0]).includes("/convert-to-issue") && call[1]?.method === "POST"
				)
			).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test FeedbackList`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the island**

Create `apps/web/src/islands/FeedbackList.tsx`:

```tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface Feedback {
	id: string;
	sourceId: string;
	sourceName: string | null;
	rating: number | null;
	ratingScale: string | null;
	body: string | null;
	submitterLabel: string | null;
	sourceUrl: string | null;
	appVersion: string | null;
	status: string;
	linkedIssueId: string | null;
	createdAt: number;
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
}

const TD = "px-3 py-2 border-b border-border align-top text-[0.875rem]";
const TH = "text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function ratingDisplay(rating: number | null, scale: string | null): string {
	if (rating === null) return "—";
	if (scale === "thumbs") return rating > 0 ? "👍" : "👎";
	return "★".repeat(Math.max(0, Math.min(5, rating)));
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

export default function FeedbackList({ workspaceSlug, projectId }: Props) {
	const [rows, setRows] = useState<Feedback[]>([]);
	const [status, setStatus] = useState("");
	const [sourceFilter, setSourceFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchRows = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams();
			if (status) params.set("status", status);
			if (sourceFilter) params.set("sourceId", sourceFilter);
			const qs = params.toString();
			const data = await apiFetch<Feedback[]>(
				`/api/projects/${projectId}/feedback${qs ? `?${qs}` : ""}`,
				{ workspaceSlug }
			);
			setRows(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, status, sourceFilter, workspaceSlug]);

	useEffect(() => {
		fetchRows();
	}, [fetchRows]);

	async function convert(id: string) {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/${id}/convert-to-issue`, {
				method: "POST",
				workspaceSlug,
			});
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	const sourceOptions = Array.from(
		new Map(rows.filter((r) => r.sourceName).map((r) => [r.sourceId, r.sourceName])).entries()
	);

	return (
		<section>
			<div class="flex gap-4 items-end mb-4">
				<div class="flex flex-col gap-1">
					<label class="text-[0.8rem] font-semibold text-text-muted" for="fb-status">
						Status
					</label>
					<select
						id="fb-status"
						class="px-2 py-1 border border-border rounded bg-bg text-text-base text-sm"
						value={status}
						onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
					>
						<option value="">All</option>
						<option value="new">New</option>
						<option value="reviewed">Reviewed</option>
						<option value="actioned">Actioned</option>
					</select>
				</div>
				<div class="flex flex-col gap-1">
					<label class="text-[0.8rem] font-semibold text-text-muted" for="fb-source">
						Source
					</label>
					<select
						id="fb-source"
						class="px-2 py-1 border border-border rounded bg-bg text-text-base text-sm"
						value={sourceFilter}
						onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value)}
					>
						<option value="">All sources</option>
						{sourceOptions.map(([id, name]) => (
							<option key={id} value={id}>
								{name}
							</option>
						))}
					</select>
				</div>
			</div>

			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}
			{loading ? (
				<p aria-live="polite">Loading feedback…</p>
			) : rows.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback yet.
				</div>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr>
								<th class={TH}>Rating</th>
								<th class={TH}>Feedback</th>
								<th class={TH}>Source</th>
								<th class={TH}>Status</th>
								<th class={TH}>Received</th>
								<th class={TH}></th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id}>
									<td class={TD}>{ratingDisplay(r.rating, r.ratingScale)}</td>
									<td class={`${TD} text-text-base`}>
										<div>{r.body ?? "—"}</div>
										{r.submitterLabel && (
											<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
										)}
									</td>
									<td class={`${TD} text-text-muted`}>{r.sourceName ?? "—"}</td>
									<td class={`${TD} text-text-muted`}>{r.status}</td>
									<td class={`${TD} text-text-muted`}>{formatDate(r.createdAt)}</td>
									<td class={`${TD} whitespace-nowrap`}>
										{r.linkedIssueId ? (
											<span class="text-[0.8rem] text-text-muted">Linked</span>
										) : (
											<button
												type="button"
												class="btn btn-outline btn-sm"
												onClick={() => convert(r.id)}
											>
												Convert to issue
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
```

**Note on the viewer-hidden convert button:** the button is shown to all readers here and the API returns 403 for viewers. If a pre-check is desired later, resolve the effective project role and hide the button (matching the design doc's "hidden for viewer"); for v1 the reactive-403 approach mirrors `TokenManager`. Flagged for the reviewer.

- [ ] **Step 4: Mount on the page**

In `apps/web/src/pages/feedback.astro`, add the import and mount below `FeedbackSourceManager`:

```astro
import FeedbackList from '../islands/FeedbackList';
```

```astro
    <FeedbackSourceManager client:load workspaceSlug={import.meta.env.PUBLIC_WORKSPACE_SLUG} projectId={Astro.url.searchParams.get('projectId') ?? ''} />
    <FeedbackList client:load workspaceSlug={import.meta.env.PUBLIC_WORKSPACE_SLUG} projectId={Astro.url.searchParams.get('projectId') ?? ''} />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test FeedbackList`
Expected: PASS (3 tests).

- [ ] **Step 6: Full suite + build gate**

Run: `pnpm --filter @projektor/api test && pnpm --filter @projektor/web test && pnpm --filter @projektor/web build`
Expected: all pass; web build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/islands/FeedbackList.tsx apps/web/src/islands/FeedbackList.test.tsx apps/web/src/pages/feedback.astro
git commit -m "feat(web): feedback triage list island (PROJ-378)"
```

---

## Self-Review

**1. Spec coverage** — every requirement maps to a task:

| Spec requirement | Task |
|---|---|
| Rename to "feedback source", one token per source | 1 (schema), 3 (service) |
| `feedback_sources` table (id + separate token_hash, name, description, is_active, allowed_origins, revoked_at) | 1 |
| `feedback` table parented on `source_id`, denormalized ws/project | 1 |
| Migration registered in `test/migrations.ts` | 1 (Step 4) |
| Zod schemas (submit at-least-one-of + ratingScale-iff-rating; source mgmt) | 2 |
| Source create/list/update/rotate/revoke, admin/owner-gated, 404-before-403 | 3 |
| Token rotation keeps id/name/history, kills old token | 3 (service), 7 (test proves it end-to-end) |
| `is_active` hard kill → submit 403 | 4 |
| Public submit: token verify, resolve ids from source, revoked→401, unknown→401, inactive→403, validation→400 | 4 |
| Dual-keyed rate limit | 4 |
| Per-source CORS (header only for listed origin; null → none; OPTIONS preflight) | 4 |
| Triage list with status + source filter, requireProjectAccess 404 | 5 |
| PATCH status, viewer 403 | 5 |
| Convert-to-issue reusing `createIssue`, sets linked_issue_id + actioned, viewer 403 | 6 |
| REST↔MCP parity for management (5 tools), rich descriptions | 7 |
| `submit_feedback` deliberately has NO MCP tool | 7 (only 5 tools added; noted) |
| REST routes: feedback-sources throughout, /rotate, PATCH name/description/isActive | 3 |
| Web: source-management island (mint name+desc+origins, shown-once, list, toggle, rotate-confirm, revoke) | 9 |
| Web: triage list shows/filters by source name | 10 |
| Web: Feedback nav tab | 8 |
| Testing plan (CRUD+gating, rotation, inactive 403, revoked 401, cross-source isolation, MCP tests) | 3,4,5,6,7 |

Infra Ticket 5 (CF Access exclusion) is out of this repo's scope — correctly not a code task.

**2. Placeholder scan** — no "TBD"/"similar to Task N"/"add error handling" left; every code and test step contains complete code. The only forward references are in Interfaces blocks (by design) and the page-shell note in Task 8 (resolved by Tasks 9-10 adding mounts).

**3. Type/signature consistency** — verified across tasks:
- `createFeedbackSource`/`rotateFeedbackSourceToken` return `{ token }` (raw once); `list` returns `tokenPreview` (never raw) — consistent in service (3), MCP (7), tests.
- `submitFeedback(db, token, rawBody, requestOrigin)` signature matches its route caller (4) and is unchanged afterward.
- `FeedbackView`/`FeedbackSourceView` field names (camelCase) match what the islands consume (`sourceName`, `tokenPreview`, `isActive`, `linkedIssueId`) in Tasks 9-10.
- `convertFeedbackToIssue` returns `createIssue`'s `{ id, number? }`; route returns it with 201; test asserts `issue.id`.
- Rejection codes consistent everywhere: revoked/unknown → 401, inactive → 403 (service throws NotFound/Forbidden; submit route maps NotFound→401).

All checks pass.

## Points a human should sanity-check before/during execution

Reviewed and resolved (spec + this plan updated accordingly):

1. **Revoked=401 vs inactive=403** — confirmed as intended: 401="no valid credential" (unknown/revoked), 403="valid credential, paused" (`is_active=0`). No change.
2. **Mounting the public submit router before global `logger()`/`cors()`** — confirmed necessary and legitimate: it's the same ordering technique already used for `/api/health` (mounted ahead of the `/api/*` rate-limit `.use()` so health checks stay unrate-limited), not an isolated workaround. Because this also drops the global `logger()`, Task 4 now adds a router-scoped `feedbackPublicRouter.use("*", logger())` so submit requests stay logged (Step 5).
3. **CORS is browser-enforced, not a server block** — confirmed intentional: a submission from a non-listed origin is still inserted (just without the ACAO header), consistent with "the token is the trust boundary, not the origin." No server-side origin rejection added.
4. **`priority: "medium"` + 120-char title truncation + footer wording** in convert-to-issue — confirmed: `"medium"` is a valid `PriorityEnum` value (`schemas/common.ts`). No change.
5. **Rate-limit vars — CHANGED from the original plan.** Now uses **dedicated** `RATE_LIMIT_FEEDBACK_MAX` (default 30, token-keyed) / `RATE_LIMIT_FEEDBACK_IP_MAX` (default 100, IP-keyed) env vars, added to `packages/types/src/env.ts` in Task 4 Step 3, instead of reusing `RATE_LIMIT_API_MAX`/`RATE_LIMIT_AUTH_MAX` — those govern authenticated traffic, and the submit route runs outside that middleware chain entirely regardless, so sharing a budget with authenticated callers was never the right default.
6. **MCP `ForbiddenError` → `-32000`** (not a distinct code) for member/viewer — confirmed correct, matches `toMcpError`'s existing mapping; tests assert `-32000`. No change.
