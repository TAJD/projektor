---
title: "Versioning and releasing"
description: "How Projektor is versioned, how a release is cut, and what the release artifact contains."
sidebar:
  order: 4
---
> Reference detail moved out of [`AGENTS.md`](https://github.com/TAJD/projektor/blob/main/AGENTS.md), which keeps only the rules every change must follow.

## Versioning

**`apps/web/package.json` is the single version source** for the whole monorepo -
bumped by `release-prepare.yml`, tagged by `release-tag.yml`, and read by
`release.yml`/`scripts/build-release.sh` to produce the release artifact (embedded
as `VERSION` in the tarball and injected into the MCP `serverInfo.version` via
esbuild `--define`). Every other `apps/*`/`packages/*` package's `package.json`
`version` field is a fixed `0.0.0-workspace` placeholder — those packages are
workspace-internal and not independently released, so their version field is unused
and intentionally never bumped. `plugins/*` packages carry their own unused
placeholder versions (e.g. `0.0.0`, `0.0.1`), not `0.0.0-workspace`.

**Releasing:** run the `release-prepare.yml` workflow (patch/minor/major); it opens a
`release`-labelled version-bump PR. Merging it fires `release-tag.yml`, which tags `vX.Y.Z`
and triggers `release.yml` to build the artifact that the config-only deploy repo
(`projektor-deploy-example`) ships. Don't tag by hand. See the
[deploy guide](https://tajd.github.io/projektor/guides/deploying/).

## What ships

projektor publishes a self-contained **release artifact** on each `v*` tag; a config-only deploy repo (e.g. `projektor-deploy-example`) downloads it and ships it with `wrangler` — no submodule, no source checkout downstream. The Worker (`apps/api`) and the built frontend (`apps/web/dist`) ship together: the deploy repo's `wrangler.toml` (from `scripts/release-assets/wrangler.example.toml`) declares an `[assets]` binding with `run_worker_first = ["/api/*", "/mcp/*", "/wiki", "/.well-known/*"]`, so those paths always hit the Hono Worker while every other path serves the static Astro output (per-route HTML, asset-first). The release build compiles `apps/web` and bundles the Worker into a single `worker.js`.

The root `pnpm deploy` script is not the release path: it runs `wrangler deploy` in
`apps/api` with the placeholder resource ids from `apps/api/wrangler.toml`, applies no
migrations and ships no frontend. Deploy through the release artifact instead.
