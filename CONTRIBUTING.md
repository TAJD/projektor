# Contributing

Thanks for looking at projektor. Bug reports, questions, docs fixes, and code are
all welcome, and a small first pull request is a great way to start.

projektor is open source under the [MIT licence](./LICENSE). Everyone taking part
is asked to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug or ask a question** using the
  [issue templates](https://github.com/TAJD/projektor/issues/new/choose).
- **Improve the docs.** The docs site lives in `apps/docs`. If something was
  confusing when you set projektor up, that's worth fixing.
- **Pick up an issue** - see [Picking an issue](#picking-an-issue) below.
- **Security issues** go through [SECURITY.md](./SECURITY.md): report them
  privately, not as a public issue.

## Running it locally

You need Node 22.12 or newer and pnpm. The full setup is in the
[Dev workflow](./AGENTS.md#dev-workflow) section of AGENTS.md; the short version:

```bash
pnpm install

# One-time local secrets so the frontend can auth without Cloudflare Access
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env

pnpm dev    # API on :8787, web on :4321 (applies local D1 migrations first)

# In another terminal: seed a workspace, user and token
# (it also prints the `claude mcp add ...` command to connect an agent)
curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap
```

Then open http://localhost:4321. You don't need a Cloudflare account for local
development: the API runs on Miniflare with a local D1 database.

`pnpm install` also sets up a pre-commit hook that type-checks and lints your
changed files.

## Picking an issue

- Issues labelled
  [`good first issue`](https://github.com/TAJD/projektor/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  are small and self-contained, with the files to change and what "done" looks
  like written down.
- Leave a comment on the issue before you start, so nobody duplicates the work
  and I can point you at anything useful.
- For a larger change or a new feature, please open an issue (or comment on an
  existing one) first, so we can agree the shape before you put time into it.

## How the code is organised

[AGENTS.md](./AGENTS.md) is the source of truth for conventions - for humans as
well as agents, despite the name. The parts worth reading first:

- **The service-layer contract.** Business logic lives in
  `apps/api/src/services/`; REST routes and MCP tools are thin wrappers over it
  and must stay at parity.
- **File layout per domain**, including where tests go.
- **Conventions & gotchas**, such as registering new migrations in the test setup.

When you fix a bug or add a feature, add a test that confirms the behaviour.

## Before opening a pull request

CI (`.github/workflows/ci.yml`) runs these on every pull request, and they all
need to pass before merge:

```bash
pnpm gen:docs                                # must leave no diff
pnpm lint
pnpm turbo type-check
pnpm --filter @projektor/db test
pnpm --filter @projektor/api test:coverage
pnpm --filter @projektor/web test:coverage
pnpm --filter @projektor/web build
pnpm bundle-budget
pnpm --filter @projektor/docs build
```

For a small change you don't have to run all of them locally: run the ones for
the packages you touched, and CI will catch the rest. The pull request template
has a short checklist.

## Review

projektor has one maintainer (me, Tom), working alongside AI agents. In practice:

- I read every issue and pull request, but reviews happen when I can get to them
  rather than on a fixed schedule. A friendly nudge after a week is fine.
- Small, focused pull requests get reviewed and merged fastest.
- I may suggest changes, or occasionally push small fixes to your branch to get
  it over the line.
- I cut releases after merge, so there's nothing release-related you need to do.
