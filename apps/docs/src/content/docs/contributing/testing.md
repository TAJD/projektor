---
title: "Testing and git hooks"
description: "Running one test, the two API test runtimes, the Playwright end-to-end suite, and the pre-commit hook."
sidebar:
  order: 2
---
> Reference detail moved out of [`AGENTS.md`](https://github.com/TAJD/projektor/blob/main/AGENTS.md), which keeps only the rules every change must follow.

## Running tests

The full set CI runs is under "Before opening a PR" in
[`AGENTS.md`](/projektor/contributing/conventions/#dev-workflow). To run less than that:

```bash
# One API test file
pnpm --filter @projektor/api exec vitest run src/test/comments.test.ts

# One test by name
pnpm --filter @projektor/api exec vitest run src/test/comments.test.ts -t "rejects"

# One web test file
pnpm --filter @projektor/web exec vitest run src/islands/ProjectNav.test.tsx
```

The API suite has two vitest projects (`apps/api/vitest.config.mts`):

- `*.test.ts` run inside the Workers runtime against an in-process Worker and D1.
- `*.node.test.ts` run in plain Node, because they read source files off disk. The
  architecture tests in `apps/api/src/test/architecture/` are these: they fail the build
  on a service that skips the access guard, an FK `ON DELETE` with no explicit cleanup,
  or an un-chunked `inArray`.

The Workers tests back D1 with SQLite, so they cannot see D1's 100-bound-parameter cap.

## E2E testing (`apps/web/e2e`, Playwright)

Targets a **deployed dev instance** (`E2E_BASE_URL`), not local dev — see `apps/web/e2e/README.md` for the full setup, fixtures, and per-spec breakdown. Not run in CI (no live deployment there); run manually or on a schedule.

Three projects, pick the narrowest one that answers your question:
- `desktop` — default viewport, Chromium.
- `mobile` — 375×812 viewport via Chromium's mobile emulation. Fast, good for layout/CSS regressions.
- `mobile-webkit` — real WebKit engine (`devices["iPhone 13"]`). Reach for this specifically when investigating iOS Safari engine-level behavior that Chromium can't reproduce (visual-viewport/on-screen-keyboard resize events, `position: fixed` under scroll, etc.) — it caught the PROJ-397/PROJ-566 class of mobile-modal bugs. Still not a substitute for a real device: no Safari chrome, no PWA install/Add-to-Home-Screen coverage.

```bash
pnpm --filter @projektor/web exec playwright test --project=mobile-webkit
```

## Git hooks (lefthook)

`pnpm install` runs `prepare`, which calls `lefthook install` and wires one hook:

- **pre-commit** — `pnpm turbo type-check` (fast; leverages turbo's cache, near-instant on unchanged packages) and `pnpm biome check --changed --no-errors-on-unmatched` (lint, changed files only).

There is deliberately no `pre-push` hook: CI is the gate (main is PR-protected), and the old hook could report a successful push after its test step failed. Don't re-add one without solving that.

CI runs the full **Before opening a PR** set above; the hook is only a fast subset.

**Bypass for WIP commits:** pass `--no-verify` (or `-n`) to git:

```bash
git commit --no-verify -m "wip: …"
```

Agent workers should also use `--no-verify` for intermediate commits; run the full checks (listed under "Before opening a PR" above) before opening a PR.
