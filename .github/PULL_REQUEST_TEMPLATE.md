<!--
Thanks for contributing! A few notes:
- Keep the PR to one change. If it resolves a tracked issue, reference it below.
- Please don't add the `release` label: it tags a release when the PR merges.
-->

## What changed

<!-- A short summary of the change and why it's needed. -->

Closes #<!-- GitHub issue number -->, or Projektor ref <!-- e.g. PROJ-123 -->

## How it was verified

<!-- Commands you ran and what they showed. New behaviour should come with a test. -->

## Checklist

- [ ] Added or updated a test for the behaviour change (not needed for docs-only changes)
- [ ] `pnpm lint` passes
- [ ] `pnpm turbo type-check` passes
- [ ] The tests for the packages I touched pass (`pnpm --filter @projektor/api test:coverage`, `pnpm --filter @projektor/web test:coverage`, `pnpm --filter @projektor/db test`)
- [ ] `pnpm gen:docs` leaves no diff
- [ ] If this adds or changes a REST route or MCP tool, both surfaces are updated (see the service-layer contract in [AGENTS.md](https://github.com/TAJD/projektor/blob/main/AGENTS.md))
- [ ] If this adds a migration, it's also registered in `apps/api/src/test/migrations.ts`
