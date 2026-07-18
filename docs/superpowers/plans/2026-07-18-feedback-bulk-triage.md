# Feedback Bulk Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select bulk "mark reviewed" and bulk "convert to issue" (as one combined issue) to the feedback admin table.

**Architecture:** Two new service functions in `apps/api/src/services/feedback.ts` (`bulkMarkReviewed`, `bulkConvertToIssue`), two new routes on the existing `authedRouter` in `apps/api/src/routes/feedback.ts`, and a checkbox column + bulk action bar added to `apps/web/src/islands/FeedbackList.tsx`.

**Tech Stack:** Hono routes, raw D1 (`ctx.db.prepare`), Zod schemas, Preact islands, Vitest (`cloudflare:test` for API, `@testing-library/preact` for web).

## Global Constraints

- Bulk convert-to-issue is all-or-nothing: if any selected `feedbackId` is already linked to an issue, reject the entire batch with 409 and mutate nothing.
- Both endpoints require `canWriteProject` (member+); viewers get 403.
- IN-clause queries must go through `inChunks` (from `apps/api/src/services/sql.ts`) to stay under D1's 100-bound-parameter cap — never bind a caller-supplied array directly into a query.
- Combined issue title: `"${N} feedback items"`. Body: each feedback rendered as a numbered section using the existing `ratingLabel()` + footer format from `convertFeedbackToIssue`, joined with blank lines.
- Follow the existing file's patterns exactly: raw `ctx.db.prepare(...).bind(...)`, not drizzle (this file doesn't use the ORM).

---

### Task 1: `bulkMarkReviewed` service function + schema + tests

**Files:**
- Modify: `apps/api/src/schemas/feedback.ts`
- Modify: `apps/api/src/services/feedback.ts`
- Create: `apps/api/src/test/feedback-bulk.test.ts`

**Interfaces:**
- Produces: `bulkMarkReviewed(ctx: ServiceCtx, input: unknown): Promise<{ updated: number }>`
- Produces: `BulkFeedbackIdsSchema` (zod), exported from `apps/api/src/schemas/feedback.ts`, shape `{ projectId: string, feedbackIds: string[] }` (min 1, max 500 ids).

- [ ] **Step 1: Add the schema**

Add to `apps/api/src/schemas/feedback.ts` (after `ConvertFeedbackSchema`):

```typescript
export const BulkFeedbackIdsSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	feedbackIds: z.array(z.string().min(1)).min(1, "At least one feedbackId is required").max(500),
});
```

- [ ] **Step 2: Write the failing test for bulk mark-reviewed**

Create `apps/api/src/test/feedback-bulk.test.ts`:

```typescript
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedProjectFixture } from "./helpers";

async function mintSource(
	f: { projectId: string; token: string; slug: string },
	body: Record<string, unknown> = { name: "Widget" }
): Promise<void> {
	await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify(body),
	});
}

async function seedFeedbackRow(
	sourceId: string,
	workspaceId: string,
	projectId: string,
	opts: {
		rating?: number;
		ratingScale?: string;
		body?: string;
		submitterLabel?: string;
		status?: string;
		linkedIssueId?: string;
	} = {}
): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO feedback
       (id, source_id, workspace_id, project_id, rating, rating_scale, body, submitter_label, status, linked_issue_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			sourceId,
			workspaceId,
			projectId,
			opts.rating ?? null,
			opts.ratingScale ?? null,
			opts.body ?? null,
			opts.submitterLabel ?? null,
			opts.status ?? "new",
			opts.linkedIssueId ?? null,
			100
		)
		.run();
	return id;
}

async function firstSourceId(projectId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
		.bind(projectId)
		.first<{ id: string }>();
	return row!.id;
}

describe("POST /api/projects/:id/feedback/bulk-mark-reviewed", () => {
	it("marks all selected rows reviewed regardless of starting status", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId, { status: "new" });
		const id2 = await seedFeedbackRow(src, f.workspaceId, f.projectId, { status: "actioned" });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, id2] }),
			}
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: 2 });

		const rows = await env.DB.prepare("SELECT status FROM feedback WHERE id IN (?, ?)")
			.bind(id1, id2)
			.all<{ status: string }>();
		expect(rows.results.every((r) => r.status === "reviewed")).toBe(true);
	});

	it("ignores feedbackIds from another project", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const other = await seedProjectFixture({ role: "owner" });
		await mintSource(other);
		const otherSrc = await firstSourceId(other.projectId);
		const foreignId = await seedFeedbackRow(otherSrc, other.workspaceId, other.projectId);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [foreignId] }),
			}
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: 0 });

		const row = await env.DB.prepare("SELECT status FROM feedback WHERE id = ?")
			.bind(foreignId)
			.first<{ status: string }>();
		expect(row!.status).toBe("new");
	});

	it("403s for a viewer", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-mark-reviewed`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: ["nonexistent"] }),
			}
		);
		expect(res.status).toBe(403);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @projektor/api test feedback-bulk -- --run`
Expected: FAIL — route `/bulk-mark-reviewed` doesn't exist yet (404), and `bulkMarkReviewed` isn't exported.

- [ ] **Step 4: Implement `bulkMarkReviewed`**

Add to `apps/api/src/services/feedback.ts`, after `convertFeedbackToIssue` (after line 243, before `export interface FeedbackVersionSummary`). Add `BulkFeedbackIdsSchema` to the existing import block at the top of the file (Step 1's schema), and add `import { inChunks } from "./sql";` to the imports:

```typescript
export async function bulkMarkReviewed(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ updated: number }> {
	const parsed = BulkFeedbackIdsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackIds } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	let updated = 0;
	await inChunks(feedbackIds, async (chunk) => {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await ctx.db
			.prepare(
				`UPDATE feedback SET status = 'reviewed'
         WHERE id IN (${placeholders}) AND project_id = ? AND workspace_id = ?`
			)
			.bind(...chunk, projectId, ctx.workspaceId)
			.run();
		updated += result.meta.changes;
		return [];
	});

	return { updated };
}
```

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/feedback.ts`, add `bulkMarkReviewed` to the import from `../services/feedback`, and add this route after the `PATCH /:id/feedback/:feedbackId` route (after line 117, before the `convert-to-issue` route):

```typescript
authedRouter.post("/:id/feedback/bulk-mark-reviewed", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const raw = await c.req.json();
	try {
		return c.json(await bulkMarkReviewed(ctx, { ...raw, projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @projektor/api test feedback-bulk -- --run`
Expected: PASS (3/3)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/schemas/feedback.ts apps/api/src/services/feedback.ts apps/api/src/routes/feedback.ts apps/api/src/test/feedback-bulk.test.ts
git commit -m "feat(api): add bulk mark-reviewed endpoint for feedback"
```

---

### Task 2: `bulkConvertToIssue` service function + tests

**Files:**
- Modify: `apps/api/src/services/feedback.ts`
- Modify: `apps/api/src/routes/feedback.ts`
- Modify: `apps/api/src/test/feedback-bulk.test.ts`

**Interfaces:**
- Consumes: `BulkFeedbackIdsSchema` (Task 1), `ratingLabel()` (existing, `apps/api/src/services/feedback.ts:182`), `createIssue()` (existing, `apps/api/src/services/issues.ts:641`), `inChunks()` (existing, `apps/api/src/services/sql.ts`).
- Produces: `bulkConvertToIssue(ctx: ServiceCtx, input: unknown): Promise<{ id: string; number?: number; convertedCount: number }>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/test/feedback-bulk.test.ts`:

```typescript
describe("POST /api/projects/:id/feedback/bulk-convert-to-issue", () => {
	it("creates one combined issue and links all selected rows", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			rating: 1,
			ratingScale: "thumbs",
			body: "Love it",
			submitterLabel: "a@b.com",
		});
		const id2 = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			rating: -1,
			ratingScale: "thumbs",
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, id2] }),
			}
		);
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string; convertedCount: number };
		expect(created.convertedCount).toBe(2);

		const rows = await env.DB.prepare(
			"SELECT linked_issue_id, status FROM feedback WHERE id IN (?, ?)"
		)
			.bind(id1, id2)
			.all<{ linked_issue_id: string; status: string }>();
		expect(rows.results).toHaveLength(2);
		for (const row of rows.results) {
			expect(row.linked_issue_id).toBe(created.id);
			expect(row.status).toBe("actioned");
		}

		const issue = await env.DB.prepare("SELECT title, body FROM issues WHERE id = ?")
			.bind(created.id)
			.first<{ title: string; body: string }>();
		expect(issue!.title).toBe("2 feedback items");
		expect(issue!.body).toContain("Love it");
		expect(issue!.body).toContain("a@b.com");
	});

	it("rejects the whole batch (creates no issue, mutates nothing) if any row is already converted", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const freshId = await seedFeedbackRow(src, f.workspaceId, f.projectId);
		const convertedId = await seedFeedbackRow(src, f.workspaceId, f.projectId, {
			linkedIssueId: "existing-issue",
			status: "actioned",
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [freshId, convertedId] }),
			}
		);
		expect(res.status).toBe(409);

		const fresh = await env.DB.prepare("SELECT linked_issue_id, status FROM feedback WHERE id = ?")
			.bind(freshId)
			.first<{ linked_issue_id: string | null; status: string }>();
		expect(fresh!.linked_issue_id).toBeNull();
		expect(fresh!.status).toBe("new");
	});

	it("404s if a feedbackId doesn't belong to the project", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await firstSourceId(f.projectId);
		const id1 = await seedFeedbackRow(src, f.workspaceId, f.projectId);

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: [id1, "nonexistent-id"] }),
			}
		);
		expect(res.status).toBe(404);
	});

	it("403s for a viewer", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback/bulk-convert-to-issue`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ feedbackIds: ["nonexistent"] }),
			}
		);
		expect(res.status).toBe(403);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @projektor/api test feedback-bulk -- --run`
Expected: FAIL — `/bulk-convert-to-issue` route doesn't exist.

- [ ] **Step 3: Implement `bulkConvertToIssue`**

Add to `apps/api/src/services/feedback.ts`, directly after `bulkMarkReviewed` (from Task 1):

```typescript
interface BulkConvertFeedbackRow {
	id: string;
	rating: number | null;
	rating_scale: string | null;
	body: string | null;
	submitter_label: string | null;
	linked_issue_id: string | null;
}

export async function bulkConvertToIssue(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; number?: number; convertedCount: number }> {
	const parsed = BulkFeedbackIdsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackIds } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	const rows = await inChunks(feedbackIds, (chunk) => {
		const placeholders = chunk.map(() => "?").join(", ");
		return ctx.db
			.prepare(
				`SELECT id, rating, rating_scale, body, submitter_label, linked_issue_id
         FROM feedback WHERE id IN (${placeholders}) AND project_id = ? AND workspace_id = ?`
			)
			.bind(...chunk, projectId, ctx.workspaceId)
			.all<BulkConvertFeedbackRow>()
			.then((r) => r.results);
	});
	if (rows.length !== feedbackIds.length) throw new NotFoundError("Feedback not found");
	// All-or-nothing: any row already converted rejects the whole batch rather than
	// partially converting or silently re-linking.
	if (rows.some((r) => r.linked_issue_id)) {
		throw new ConflictError("One or more selected items are already linked to an issue");
	}

	const byId = new Map(rows.map((r) => [r.id, r]));
	const orderedRows = feedbackIds.map((id) => byId.get(id)!);
	const body = orderedRows
		.map((fb, i) => {
			const footer =
				`— submitted via feedback source${fb.submitter_label ? ` by ${fb.submitter_label}` : ""}` +
				(fb.rating !== null ? `, rating: ${fb.rating} (${fb.rating_scale})` : "");
			return [`${i + 1}. ${ratingLabel(fb.rating, fb.rating_scale)}`, fb.body ?? "", footer].join(
				"\n"
			);
		})
		.join("\n\n");

	const issue = await createIssue(ctx, {
		projectId,
		title: `${feedbackIds.length} feedback items`,
		body,
		priority: "medium",
	});

	await inChunks(feedbackIds, (chunk) => {
		const placeholders = chunk.map(() => "?").join(", ");
		return ctx.db
			.prepare(
				`UPDATE feedback SET linked_issue_id = ?, status = 'actioned'
         WHERE id IN (${placeholders}) AND workspace_id = ?`
			)
			.bind(issue.id, ...chunk, ctx.workspaceId)
			.run()
			.then(() => []);
	});

	return { ...issue, convertedCount: feedbackIds.length };
}
```

- [ ] **Step 4: Wire the route**

In `apps/api/src/routes/feedback.ts`, add `bulkConvertToIssue` to the import from `../services/feedback`, and add this route after the `bulk-mark-reviewed` route from Task 1:

```typescript
authedRouter.post("/:id/feedback/bulk-convert-to-issue", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const raw = await c.req.json();
	try {
		return c.json(await bulkConvertToIssue(ctx, { ...raw, projectId }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @projektor/api test feedback-bulk -- --run`
Expected: PASS (7/7 total in the file)

- [ ] **Step 6: Run the full API suite**

Run: `pnpm --filter @projektor/api test -- --run`
Expected: all tests pass (no regressions)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/feedback.ts apps/api/src/routes/feedback.ts apps/api/src/test/feedback-bulk.test.ts
git commit -m "feat(api): add bulk convert-to-issue endpoint for feedback"
```

---

### Task 3: UI — checkbox column and bulk action bar

**Files:**
- Modify: `apps/web/src/islands/FeedbackList.tsx`
- Modify: `apps/web/src/islands/FeedbackList.test.tsx`

**Interfaces:**
- Consumes: `POST /api/projects/:id/feedback/bulk-mark-reviewed` and `POST /api/projects/:id/feedback/bulk-convert-to-issue` (Tasks 1-2), both accepting `{ feedbackIds: string[] }` in the JSON body, via the existing `apiFetch<T>(path, { method, body, workspaceSlug })` helper (`apps/web/src/utils/api-client.ts`) which throws `Error` on a non-2xx response.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/islands/FeedbackList.test.tsx`. Extend `stubFetch` to handle the two new endpoints and add a second fixture row so multi-select has two rows to work with:

```typescript
const ROW_2 = {
	id: "f2",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: -1,
	ratingScale: "thumbs",
	body: "Confusing step",
	submitterLabel: null,
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1001,
};
```

Replace the `stubFetch` function with a version that also handles the bulk endpoints:

```typescript
function stubFetch(rows: unknown[] = [ROW, ROW_2], bulkConvertStatus = 201) {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/bulk-convert-to-issue")) {
			if (bulkConvertStatus !== 201) {
				return Promise.resolve({
					ok: false,
					status: bulkConvertStatus,
					json: () => Promise.resolve({ error: "Conflict" }),
				});
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ id: "issue-1", convertedCount: 2 }),
			});
		}
		if (u.includes("/bulk-mark-reviewed")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ updated: 2 }) });
		}
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
```

Add these tests at the end of the `describe("FeedbackList", ...)` block:

```typescript
	it("select-all then bulk mark-reviewed POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Mark all reviewed$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-mark-reviewed")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.length === 2 && call[1]?.method === "POST";
				})
			).toBe(true);
		});
	});

	it("select-all then bulk convert-to-issue POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-convert-to-issue")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.includes("f1") && body.feedbackIds.includes("f2");
				})
			).toBe(true);
		});
	});

	it("shows an error and keeps the selection when bulk convert-to-issue conflicts", async () => {
		stubFetch([ROW, ROW_2], 409);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/2 selected/i)).toBeTruthy();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @projektor/web test FeedbackList -- --run`
Expected: FAIL — no "select all" label, no bulk buttons, no "N selected" text.

- [ ] **Step 3: Implement the checkbox column and bulk action bar**

In `apps/web/src/islands/FeedbackList.tsx`:

Add `selected` state after the existing `error` state (after line 49):

```typescript
	const [selected, setSelected] = useState<Set<string>>(new Set());
```

Clear selection when filters change — replace the `setStatus`/`setSourceFilter` `onChange` handlers (lines 116 and 133) to also clear selection:

```typescript
						onChange={(e) => {
							setStatus((e.target as HTMLSelectElement).value);
							setSelected(new Set());
						}}
```

```typescript
							onChange={(e) => {
								setSourceFilter((e.target as HTMLSelectElement).value);
								setSelected(new Set());
							}}
```

Add the bulk action functions after `markReviewed` (after line 99):

```typescript
	async function bulkMarkReviewed() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-mark-reviewed`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function bulkConvertToIssue() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-convert-to-issue`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	function toggleSelectAll() {
		setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
	}

	function toggleRow(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
```

Add the bulk action bar, and the checkbox column header, right after the `{error && (...)}` block (after line 150, before the `{loading ? (`):

```typescript
			{selected.size > 0 && (
				<div class="flex gap-2 items-center mb-3 p-2 bg-surface border border-border rounded">
					<span class="text-[0.85rem] text-text-muted">{selected.size} selected</span>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkMarkReviewed}>
						Mark all reviewed
					</button>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkConvertToIssue}>
						Convert all to issue
					</button>
				</div>
			)}
```

Add the checkbox header column, as the first `<th>` (before line 162's `<th class={TH}>Rating</th>`):

```typescript
								<th class={TH}>
									<input
										type="checkbox"
										aria-label="select all"
										checked={rows.length > 0 && selected.size === rows.length}
										onChange={toggleSelectAll}
									/>
								</th>
```

Add the per-row checkbox cell, as the first `<td>` in the row map (before line 173's rating `<td>`):

```typescript
										<td class={TD}>
											<input
												type="checkbox"
												aria-label={`select row ${r.id}`}
												checked={selected.has(r.id)}
												onChange={() => toggleRow(r.id)}
											/>
										</td>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @projektor/web test FeedbackList -- --run`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @projektor/web test -- --run`
Expected: all tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/FeedbackList.tsx apps/web/src/islands/FeedbackList.test.tsx
git commit -m "feat(web): add bulk select and triage actions to feedback table"
```

---

### Task 4: Type-check, lint, whole-branch verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `pnpm turbo type-check`
Expected: no errors

- [ ] **Step 2: Lint**

Run: `pnpm biome check --changed`
Expected: no violations (fix with `--write` if any appear, then re-commit as part of the relevant task's changes — do not bundle into an unrelated commit)

- [ ] **Step 3: Full test suites**

Run: `pnpm --filter @projektor/api test -- --run` and `pnpm --filter @projektor/web test -- --run`
Expected: both fully green

- [ ] **Step 4: Commit if fixes were needed**

```bash
git add -A
git commit -m "fix: lint/type-check fixes for bulk triage"
```
(Skip this step if Steps 1-3 were already clean.)
