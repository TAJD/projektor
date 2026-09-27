#!/usr/bin/env -S pnpm tsx
// PROJ-841: bundle size budget for web islands/shared chunks, with a ratchet against a
// checked-in baseline (bundle-budget.json). Run after `apps/web` builds:
//
//   pnpm --filter @projektor/web build && tsx scripts/bundle-budget.ts
//   tsx scripts/bundle-budget.ts --update   # rewrite the baseline to the current build
//
// PROJ-841 references a "hygiene ratchet" (PROJ-831) it was meant to share logic with —
// PROJ-831 does not exist yet, so this ratchet is self-contained (its own tolerance,
// comparison and override handling; see bundle-budget-lib.ts). If/when PROJ-831 lands,
// this should be reconciled with it rather than kept as a second implementation.
//
// Ratchet rule: fails if a chunk's gzip size grows by more than max(2%, 1 KB) over its
// baseline entry, or a chunk in the *initial* (eagerly-loaded) group appears with no
// baseline entry at all. Chunks in the *lazy* group (mermaid and anything else only
// reachable via dynamic import — see isEagerChunk below, which reuses apps/web/scripts/
// eager-chunk-graph.mjs's static-import-graph walk from PROJ-868) may appear fresh
// without failing the build, since they never load on the initial page view.
//
// There is no override mechanism: the only way to accept a deliberate size increase is
// `--update`, which rewrites bundle-budget.json to the current build — and that file then
// has to be committed, so the reviewer sees exactly what grew and why. (An earlier version
// of this script supported a BUNDLE_BUDGET_OVERRIDE env var / PR-label escape hatch, but
// this step also runs on `workflow_call` from release.yml, where there is no PR to carry a
// label — a label-driven override would leave main permanently over budget the moment a
// labelled PR merged, breaking every later run with no way to un-stick it short of editing
// the workflow. Removed for that reason.)
//
// A chunk that *shrank* by more than the same tolerance doesn't fail either, but is worth
// a warning: it usually means the baseline is stale (the chunk was split up, or a
// dependency dropped) and due for a `--update` refresh.
//
// Chunk file names carry a content hash (e.g. `IssueList.BX52gRWz.js`), so the baseline
// is keyed by a stable name with the hash stripped (bundle-budget-lib.ts#stableChunkName).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  diffGroup,
  isFailingDelta,
  isWarningDelta,
  formatDeltaLine,
  markdownSummary,
  toStableSizes,
  type Budget,
  type ChunkDelta,
} from './bundle-budget-lib.ts';
import { buildImportGraph, closure, eagerRootsForPage } from '../apps/web/scripts/eager-chunk-graph.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url)) + '/..';
const distDir = join(repoRoot, 'apps/web/dist');
const astroDir = join(distDir, '_astro');
const baselinePath = join(repoRoot, 'bundle-budget.json');

const TOLERANCE = { toleranceRatio: 0.02, toleranceBytes: 1024 };

function fail(msg: string): never {
  console.error(`bundle-budget: ${msg}`);
  process.exit(1);
}

if (!existsSync(astroDir)) {
  fail(`${astroDir} not found — run \`pnpm --filter @projektor/web build\` first.`);
}

function findAllPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'index.html') out.push(full);
    }
  };
  walk(distDir);
  return out;
}

// ── Classify every chunk as "initial" (eagerly loaded on at least one real page) or
// "lazy" (only ever reached via dynamic import — mermaid diagrams, etc.), reusing the
// exact static-import-graph walk PROJ-868's assert-eager-chunks.mjs uses, so the two
// tickets' notions of "eager" can never drift apart.
const chunkFiles = readdirSync(astroDir).filter((f) => f.endsWith('.js') || f.endsWith('.css'));
const jsFiles = chunkFiles.filter((f) => f.endsWith('.js'));
const chunkContents = new Map(jsFiles.map((f) => [f, readFileSync(join(astroDir, f), 'utf8')]));
const importsOf = buildImportGraph(chunkContents);

const eagerFiles = new Set<string>();
for (const pagePath of findAllPages()) {
  const html = readFileSync(pagePath, 'utf8');
  const roots = eagerRootsForPage(html);
  for (const f of closure(roots, importsOf)) eagerFiles.add(f);
  // CSS is always eagerly link-tagged in the page head — treat any referenced .css as
  // part of the initial load too.
  for (const m of html.matchAll(/href="([^"]+\.css)"/g)) {
    eagerFiles.add(m[1].split('/').pop()!);
  }
}

function gzipBytes(file: string): number {
  return gzipSync(readFileSync(join(astroDir, file))).length;
}

const currentInitial: Record<string, number> = {};
const currentLazy: Record<string, number> = {};
for (const file of chunkFiles) {
  const size = gzipBytes(file);
  if (eagerFiles.has(file)) currentInitial[file] = size;
  else currentLazy[file] = size;
}

const current: Budget = {
  initial: toStableSizes(currentInitial),
  lazy: toStableSizes(currentLazy),
};

const shouldUpdate = process.argv.includes('--update');

if (shouldUpdate) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`bundle-budget: wrote baseline to ${baselinePath}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  fail(`${baselinePath} not found — run with --update to create it.`);
}

const baseline: Budget = JSON.parse(readFileSync(baselinePath, 'utf8'));

const deltas: ChunkDelta[] = [
  ...diffGroup('initial', baseline.initial ?? {}, current.initial, TOLERANCE),
  ...diffGroup('lazy', baseline.lazy ?? {}, current.lazy, TOLERANCE),
];

for (const d of deltas) console.log(`bundle-budget: [${d.group}] ${formatDeltaLine(d)}`);

const warnings = deltas.filter(isWarningDelta);
if (warnings.length > 0) {
  console.warn('bundle-budget: WARN —');
  for (const d of warnings) {
    console.warn(`  ${d.group}/${d.name}: ${formatDeltaLine(d)}`);
  }
  console.warn(
    'bundle-budget: one or more chunks shrank well past the ratchet tolerance — the ' +
      'baseline is probably stale. Not a failure; re-run with --update to refresh it.',
  );
}

const totalInitial = Object.values(current.initial).reduce((a, b) => a + b, 0);
const totalLazy = Object.values(current.lazy).reduce((a, b) => a + b, 0);
console.log(
  `bundle-budget: totals — initial ${(totalInitial / 1024).toFixed(2)} KiB gzip, ` +
    `lazy ${(totalLazy / 1024).toFixed(2)} KiB gzip`,
);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    const warnLine =
      warnings.length > 0
        ? `\n\n⚠️ ${warnings.length} chunk(s) shrank well past the ratchet tolerance — the ` +
          `baseline is probably stale. Not a failure; re-run with \`--update\` to refresh it.\n`
        : '';
    const summary =
      `## Bundle size budget (PROJ-841)\n\n` +
      `Initial load: **${(totalInitial / 1024).toFixed(2)} KiB** gzip · Lazy: **${(totalLazy / 1024).toFixed(2)} KiB** gzip\n\n` +
      `${markdownSummary(deltas)}${warnLine}\n\n` +
      `_A true PR comment (rather than this job-summary table) would need a token with ` +
      `\`pull-requests: write\`; not requested here, so this is a workflow step summary ` +
      `instead._\n`;
    writeFileSync(summaryPath, summary, { flag: 'a' });
  } catch (err) {
    console.error(`bundle-budget: could not write $GITHUB_STEP_SUMMARY: ${(err as Error).message}`);
  }
}

const failing = deltas.filter(isFailingDelta);
if (failing.length > 0) {
  console.error('bundle-budget: FAIL —');
  for (const d of failing) console.error(`  ${d.group}/${d.name}: ${formatDeltaLine(d)}`);
  console.error(
    'bundle-budget: to accept a deliberate size increase, re-run with --update to rewrite ' +
      'the baseline and commit it (and explain why in the PR). There is no override.',
  );
  process.exit(1);
}
console.log('bundle-budget: OK');
