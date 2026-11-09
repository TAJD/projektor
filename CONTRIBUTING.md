# Contributing

projektor is a personal project, built and maintained by one person (with AI
agents), and open source under the [MIT licence](./LICENSE) - fork it, deploy
it, modify it, learn from it.

## Issues and pull requests

**Pull requests, issues, and feature requests are all welcome.** Review happens
on the maintainer's own schedule rather than a fixed SLA, but everything is read
and considered.

For security issues, follow [SECURITY.md](./SECURITY.md) (report privately, not
via a public issue).

## Working in the code

[AGENTS.md](./AGENTS.md) is the source of truth for conventions: file layout,
the service-layer contract (REST and MCP must stay at parity), and how to work
in parallel without conflicts. Read it before changing anything.

The quick checks:

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

CI runs the full set; see "Before opening a PR" in [AGENTS.md](./AGENTS.md).
