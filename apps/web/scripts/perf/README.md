# Mobile performance harness (PROJ-431)

Two scripts for measuring the built app on a mobile profile against a real API. Neither
runs in CI; both are for producing numbers when changing load performance.

Both serve `apps/web/dist/` from a local server and proxy `/api`, `/auth` and `/mcp` to a
deployed Worker, so measurements include real API latency. The static server applies
brotli/gzip — without that the mobile JS figures are roughly 3× what production ships —
and replicates the Worker's fallback for pretty issue URLs, which have no prerendered
page.

```sh
pnpm --filter @projektor/web build
cd apps/web
PROJEKTOR_API_TOKEN=<token> node scripts/perf/measure-load.mjs
PROJEKTOR_API_TOKEN=<token> node scripts/perf/check-interactive.mjs
```

The token is an app bearer token. `/api` and `/mcp` are Cloudflare Access bypass apps, so
they are reachable with a bearer token alone — no Access service token needed.

## `measure-load.mjs`

Chromium via Playwright on two profiles: Pixel 5 with Lighthouse mobile throttling
(1.6 Mbps down, 750 Kbps up, 150 ms RTT, 4× CPU) and unthrottled desktop. Median of 3
runs per page. Reports FCP, LCP, DCL, JS transfer, when the last JS and last API request
finished, long-task time, and time until real content replaces the loading placeholder.
Pass paths as arguments to override the defaults — without a leading slash, which Git
Bash mangles.

Compare runs back to back. API latency drifts by several hundred ms between sessions, so
a before/after pair measured an hour apart is not comparable; the JS-side figures are
deterministic and can be trusted on their own.

## `check-interactive.mjs`

Functional checks of the PROJ-431 editing changes at 375 px and 1440 px: draft
persistence across reload, the fallback textarea while the editor chunk loads and
CodeMirror adopting what was typed into it, 16 px inputs on mobile (below that iOS Safari
zooms the viewport on focus), and 44 px toolbar touch targets on mobile while desktop
stays compact. Exits non-zero on any failure.
