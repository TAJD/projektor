# Contributing

projektor is a personal project, built and maintained by one person (with AI
agents). It's open source under the [MIT licence](./LICENSE) - fork it, deploy
it, modify it, learn from it.

## Issues and pull requests

**External issues and pull requests are automatically closed.** This isn't
hostility - it's how a solo project stays sustainable. But **everything is
read.** If you open an issue or PR:

- it will be closed automatically, and
- the maintainer will still review it, and may act on it (fix the bug, adopt the
  idea, reply) on their own schedule.

So: a closed issue is not an ignored issue. If something is broken or you have an
idea, you're welcome to file it - just don't expect a back-and-forth thread.

For security issues, follow [SECURITY.md](./SECURITY.md) (report privately, not
via a public issue).

## Working in the code

If you're modifying a fork, [AGENTS.md](./AGENTS.md) is the source of truth for
conventions: file layout, the service-layer contract (REST and MCP must stay at
parity), and how to work in parallel without conflicts. Read it before changing
anything.

Both checks must be green (CI runs a fuller set - see [AGENTS.md](./AGENTS.md)):

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```
