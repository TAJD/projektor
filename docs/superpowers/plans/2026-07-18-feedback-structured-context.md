# Feedback Structured Context Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `sourceUrl`'s query-string params generically in the feedback admin table, as a collapsible per-row toggle.

**Architecture:** Pure client-side change to `apps/web/src/islands/FeedbackList.tsx` — parse `sourceUrl` with the native `URL` API, no backend/schema change.

**Tech Stack:** Preact islands, `@testing-library/preact`, Vitest.

## Global Constraints

- No backend/schema change — `sourceUrl` is already returned by `GET /:id/feedback` (see `Feedback` interface, `apps/web/src/islands/FeedbackList.tsx:12`).
- A malformed `sourceUrl` (fails `new URL(...)`) must render no toggle and must not throw/crash the table.
- Toggle label is exactly `` `Context (${N})` `` where N is the query-param count (0 is valid — the toggle still renders so the raw-URL link stays reachable).

---

### Task 1: Context toggle + parsing + tests

**Files:**
- Modify: `apps/web/src/islands/FeedbackList.tsx`
- Modify: `apps/web/src/islands/FeedbackList.test.tsx`

**Interfaces:**
- Produces: `parseContext(sourceUrl: string | null): { url: string; params: [string, string][] } | null` — a pure helper (returns `null` for `null` input or an unparseable URL), unit-testable in isolation.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/islands/FeedbackList.test.tsx` (inside the existing `describe("FeedbackList", ...)` block, after the last test). These reuse the file's existing `ROW`/`ROW_2`/`stubFetch` fixtures — add a third fixture row with a `sourceUrl` carrying query params, and adjust `stubFetch`'s default rows array if needed to include it without changing the fixture identity (`f1`, `f2`) the pre-existing tests already key off of:

```typescript
const ROW_WITH_CONTEXT = {
	...ROW,
	id: "f3",
	sourceUrl: "https://ironvolume.example.com/wod?seed=abc123&focus=strength",
};

const ROW_BARE_URL = {
	...ROW,
	id: "f4",
	sourceUrl: "https://ironvolume.example.com/wod",
};

const ROW_MALFORMED_URL = {
	...ROW,
	id: "f5",
	sourceUrl: "not a url",
};

describe("FeedbackList structured context", () => {
	it("shows a Context toggle with the param count and expands to reveal params + raw link", async () => {
		stubFetch([ROW_WITH_CONTEXT]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		const toggle = await screen.findByRole("button", { name: /Context \(2\)/i });
		expect(screen.queryByText(/seed:/i)).toBeNull();
		fireEvent.click(toggle);
		expect(screen.getByText(/seed:\s*abc123/i)).toBeTruthy();
		expect(screen.getByText(/focus:\s*strength/i)).toBeTruthy();
		expect(screen.getByRole("link", { name: ROW_WITH_CONTEXT.sourceUrl })).toBeTruthy();
	});

	it("shows a Context (0) toggle for a sourceUrl with no query string, expanding to just the raw link", async () => {
		stubFetch([ROW_BARE_URL]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		const toggle = await screen.findByRole("button", { name: /Context \(0\)/i });
		fireEvent.click(toggle);
		expect(screen.getByRole("link", { name: ROW_BARE_URL.sourceUrl })).toBeTruthy();
	});

	it("renders no Context toggle when sourceUrl is null", async () => {
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Great onboarding");
		expect(screen.queryByRole("button", { name: /Context/i })).toBeNull();
	});

	it("renders no Context toggle for a malformed sourceUrl, without throwing", async () => {
		stubFetch([ROW_MALFORMED_URL]);
		expect(() => render(<FeedbackList workspaceSlug="my-ws" projectId="p1" />)).not.toThrow();
		await screen.findByText("Great onboarding");
		expect(screen.queryByRole("button", { name: /Context/i })).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @projektor/web test FeedbackList -- --run`
Expected: FAIL — no `parseContext` helper, no Context toggle rendered.

- [ ] **Step 3: Implement `parseContext` and the toggle UI**

In `apps/web/src/islands/FeedbackList.tsx`, add the helper after `formatDate` (after line 36):

```typescript
function parseContext(sourceUrl: string | null): { url: string; params: [string, string][] } | null {
	if (!sourceUrl) return null;
	try {
		const parsed = new URL(sourceUrl);
		return { url: sourceUrl, params: Array.from(parsed.searchParams.entries()) };
	} catch {
		return null;
	}
}
```

Add `expanded` state after the existing `selected` state (after line 50):

```typescript
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
```

Add a `toggleExpanded` function after `toggleRow` (after line 141):

```typescript
	function toggleExpanded(id: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
```

Replace the feedback-body `<td>` (lines 249-254) to add the context toggle and expanded panel below `submitterLabel`:

```typescript
									<td class={`${TD} text-text-base`}>
										<div>{r.body ?? "—"}</div>
										{r.submitterLabel && (
											<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
										)}
										{(() => {
											const context = parseContext(r.sourceUrl);
											if (!context) return null;
											return (
												<div class="mt-1">
													<button
														type="button"
														class="text-[0.75rem] text-text-muted underline"
														onClick={() => toggleExpanded(r.id)}
													>
														Context ({context.params.length})
													</button>
													{expanded.has(r.id) && (
														<div class="text-[0.75rem] text-text-muted mt-1 flex flex-col gap-0.5">
															<a
																href={context.url}
																target="_blank"
																rel="noopener noreferrer"
																class="underline"
															>
																{context.url}
															</a>
															{context.params.map(([key, value]) => (
																<div key={key}>
																	{key}: {value}
																</div>
															))}
														</div>
													)}
												</div>
											);
										})()}
									</td>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @projektor/web test FeedbackList -- --run`
Expected: PASS (all tests in the file, including the pre-existing 7 from Task 1-3 of the prior bulk-triage plan)

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @projektor/web test -- --run`
Expected: all tests pass (no regressions)

- [ ] **Step 6: Type-check and lint**

Run: `pnpm turbo type-check` and `pnpm biome check --changed`
Expected: no errors/violations (fix inline with `--write`/`--write --unsafe` if any appear, and re-run tests before committing)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/islands/FeedbackList.tsx apps/web/src/islands/FeedbackList.test.tsx
git commit -m "feat(web): surface structured context from feedback sourceUrl"
```
