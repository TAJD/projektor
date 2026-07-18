---
title: "How the island API convention plugin works"
description: "A tour of IslandApiConvention, the cofferdam plugin that enforces apiFetch usage in islands (CD-69)."
sidebar:
  order: 2
---
The [contributor conventions](/projektor/contributing/conventions/) say islands must call
the shared `apiFetch` wrapper instead of hand-rolling headers or calling `fetch()`
directly. This page explains the mechanism that enforces that rule: a small
[cofferdam](https://github.com/TAJD/cofferdam) plugin called `IslandApiConvention`, and
how it replaced an older grep script (CD-69).

## Why a cofferdam plugin instead of a grep script

The convention used to be enforced by a shell script that grepped island source files
for `buildHeaders` and `fetch(`. That worked, but it had no AST awareness — it couldn't
tell a real `fetch()` call from a string that happened to contain the word, and it
couldn't be extended to catch `window.fetch()`-style bypasses without ad-hoc regex
tweaks. Porting it to a cofferdam plugin gets a real parser, a `--format json` contract
other tooling can consume, and a location that lives alongside every other quality check
projektor runs.

The plugin lives at [`plugins/island-api`](https://github.com/TAJD/projektor/tree/main/plugins/island-api)
in the projektor repo and is built on `@cofferdam/check-sdk`'s `defineCheck()`.

## What it flags

Two independent detectors, because they need different tools:

1. **A local `buildHeaders` declaration.** Islands shouldn't build their own auth headers
   — that logic belongs in `apiFetch` (in `utils/api-client.ts`), which already handles
   auth headers and error handling consistently.
2. **A raw `fetch()` call** — including `window.fetch()`, `globalThis.fetch()`, and
   `self.fetch()` — instead of going through `apiFetch`.

```ts
function withFunctionBuildHeaders() {
  function buildHeaders(token: string) { // flagged: local buildHeaders
    return { Authorization: `Bearer ${token}` };
  }
}

export async function loadIssue(id: string) {
  const a = await fetch(`/api/issues/${id}`);        // flagged: raw fetch()
  const b = await window.fetch(`/api/issues/${id}`); // flagged: window.fetch()
  const c = await apiFetch(`/api/issues/${id}`);     // OK — approved wrapper
}
```

## Two detection mechanisms, and why they differ

### `buildHeaders`: a line scan, not an AST match

You'd expect "find a declaration named `buildHeaders`" to be an AST check, but the
check-sdk's AST surface (v0) has no `VariableDeclaration` node kind yet (tracked as
CD-78), so `const buildHeaders = (token) => ...` isn't visible to `file.ast.findAll(...)`
at all — only `function buildHeaders(...)` is. Since most real occurrences use the
`const`/arrow form, the plugin instead regex-matches against every raw line:

```ts
const BUILD_HEADERS_PATTERN = /\b(function|const)\s+buildHeaders\b/;

for (const ln of file.lines()) {
  const m = BUILD_HEADERS_PATTERN.exec(ln.text);
  if (!m) continue;
  ctx.report({
    message: 'Local "buildHeaders" declared here — use apiFetch from utils/api-client.ts instead.',
    span: ln.spanFor(m.index, m.index + m[0].length),
  });
}
```

Deliberately, this loop does **not** skip lines flagged by `LineView.isComment` or
`isStringLiteral` — the original grep script scanned raw text unconditionally, and
preserving that means the plugin doesn't silently lose coverage relative to what it
replaced (the fixture's third case exists specifically to guard against a future "skip
string-literal lines" optimization regressing this).

### Raw `fetch()`: an AST walk

Bare and member-expression `fetch` calls, by contrast, are exactly what `CallExpression`
AST matching is good at, so this half uses `file.ast.findAll("CallExpression")`:

```ts
const GLOBAL_FETCH_OBJECTS = new Set(["window", "globalThis", "self"]);

for (const call of file.ast.findAll("CallExpression")) {
  const flagged = describeRawFetchCallee(call.callee);
  if (!flagged) continue;
  ctx.report({
    message: `Raw "${flagged}" call — use apiFetch from utils/api-client.ts instead.`,
    span: call.span,
  });
}

function describeRawFetchCallee(callee) {
  if (callee.kind === "IdentifierReference" && callee.name === "fetch") {
    return "fetch()";
  }
  if (
    callee.kind === "MemberExpression" &&
    callee.property === "fetch" &&
    callee.object.kind === "IdentifierReference" &&
    GLOBAL_FETCH_OBJECTS.has(callee.object.name)
  ) {
    return `${callee.object.name}.fetch()`;
  }
  return null;
}
```

This is a deliberate *widening* over the original grep, which excluded any line
containing a `.` before `fetch(` to avoid false positives on method calls like
`someClient.fetch(...)` — that also meant it missed `window.fetch()`. The AST version
distinguishes "member access on a known global fetch object" from "member access on
some other object" precisely, so it catches the bypass the grep couldn't while still
leaving `someClient.fetch(...)` alone.

## Scoping: why `pathPatterns` ends in `**/*`, not `**`

```ts
files: {
  extensions: ["ts", "tsx"],
  pathPatterns: ["apps/web/src/islands/**/*"], // CD-70 glob workaround
},
```

The check only runs against files under `apps/web/src/islands`. The trailing `**/*`
(rather than the more natural-looking `**`) works around a glob-matching bug tracked as
CD-70 in cofferdam's own tracker: `apps/web/src/islands/**` alone never matches a file
sitting *directly* in `islands/` — it only matches files in nested subdirectories.
`**/*` is the workaround, since it matches both direct and nested files. If CD-70 is
ever fixed upstream, this pattern can be simplified, but until then any new plugin
scoped to a directory should copy this `**/*` suffix rather than assume `**` alone
covers direct files too.

## How it's wired in

- **`cofferdam.toml`** (projektor repo root) lists the plugin: `plugins = ["./plugins/island-api"]`.
- **Local pre-commit** (`lefthook.yml`): builds the plugin and runs
  `node scripts/check-island-api.mjs`, a thin wrapper around
  `cofferdam check apps/web/src/islands --format json` that filters findings down to
  `Warning.IslandApiConvention` and prints a pass/fail summary. Like any lefthook step,
  it can be bypassed locally with `--no-verify`.
- **CI** (`.github/workflows/ci.yml`): runs the same `scripts/check-island-api.mjs` as an
  unconditional job step. This is the check that can't be skipped — it gates
  every PR regardless of what happened locally.

## Testing and extending the plugin

The plugin ships its own regression fixture, independent of projektor's main test
suite: [`plugins/island-api/fixtures/apps/web/src/islands/fixture.ts`](https://github.com/TAJD/projektor/blob/main/plugins/island-api/fixtures/apps/web/src/islands/fixture.ts)
contains one example of each flagged pattern (function-form `buildHeaders`, const-form
`buildHeaders`, const-form `buildHeaders` sharing a line with a string literal, bare
`fetch()`, and `window.fetch()`), plus a few approved calls that must **not** be flagged
(`apiFetch(...)`, and `someClient.fetch(...)` on a non-global object).

`plugins/island-api/expected.json` pins the exact findings — file, line, column, byte
span, and message — cofferdam should produce against that fixture. Run the check with:

```bash
pnpm --filter @projektor/cofferdam-island-api test
```

which runs `scripts/check-fixture.mjs`: it invokes `cofferdam check` on the fixture,
filters the output to `Warning.IslandApiConvention` findings, and diffs them against
`expected.json`, failing loudly with both JSON blobs printed if anything drifts.

If you extend the plugin (say, to flag another bypass pattern), add a case to
`fixture.ts` with a comment describing the expected outcome, update `expected.json` to
match, and re-run the test above before opening a PR — the exact byte offsets in
`expected.json` mean even a one-character change earlier in the fixture file will shift
every subsequent span, so regenerate the whole file from the actual check output rather
than hand-editing offsets.
