// PROJ-868: fails the build if any *eagerly loaded* chunk on /issues, /wiki/*, or
// /projects/view statically imports mermaid's chunk graph. Mermaid (and its d3
// dependency) should only ever load when a diagram actually renders (dynamic import,
// client:visible/idle island); this is a post-build regression guard for a bug where
// rolldown's automatic "commons" chunking fused its own tiny synthetic runtime-helper
// module (`\0rolldown/runtime.js`) into the same physical chunk as mermaid's bundled
// d3-selection/dayjs code (an anonymous `src.<hash>.js`), because both @preact/signals
// and mermaid needed that helper. Every client:load island that imports @preact/signals
// (ProjectNav, WikiPage, IssueList, ...) pulled the whole fused chunk in behind it — 16 KB
// gzip on every page load even when no mermaid diagram was ever rendered.
//
// "Eager" here means: reachable, via *static* imports only, from an astro-island whose
// `client="load"` attribute means it hydrates immediately (as opposed to
// client:visible/client:idle, which defer). Astro's renderer performs a dynamic
// `import(component-url)` at hydration time, so once that fetch happens everything the
// component chunk statically imports loads with it — that static closure is "the eager
// import graph" the ticket asks for.
//
// Graph logic lives in eager-chunk-graph.mjs so it can be unit-tested without a real
// `dist/` build — see apps/web/src/test/eager-chunk-graph.test.ts.
//
// Run as a post-build step, wired into `pnpm --filter @projektor/web build` (like
// assert-sw.mjs) — see apps/web/package.json.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildImportGraph, closure, eagerRootsForPage, findOffendingChunks } from './eager-chunk-graph.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const astroDir = join(dist, '_astro');

const TARGET_PAGES = ['issues/index.html', 'projects/view/index.html'];

function findWikiPages() {
  const wikiDir = join(dist, 'wiki');
  if (!existsSync(wikiDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'index.html') out.push(full.slice(dist.length + 1));
    }
  };
  walk(wikiDir);
  return out;
}

if (!existsSync(astroDir)) {
  console.error(`assert-eager-chunks: ${astroDir} not found — run the build first.`);
  process.exit(1);
}

const chunkFiles = readdirSync(astroDir).filter((f) => f.endsWith('.js'));
const chunkContents = new Map(chunkFiles.map((f) => [f, readFileSync(join(astroDir, f), 'utf8')]));
const importsOf = buildImportGraph(chunkContents);

// The mermaid/d3 chunk set: everything statically reachable from mermaid's own entry
// chunk(s) (rolldown names it `mermaid.core.<hash>.js`). This is what catches the bug
// even when the culprit is an anonymously-named shared chunk like `src.<hash>.js`.
const mermaidRoots = chunkFiles.filter((f) => f.startsWith('mermaid.'));
if (mermaidRoots.length === 0) {
  console.error(
    'assert-eager-chunks: no mermaid.*.js chunk found in dist/_astro — mermaid chunk ' +
      'naming changed, or mermaid was removed. Update mermaidRoots detection.',
  );
  process.exit(1);
}
const mermaidSet = closure(mermaidRoots, importsOf);

function gzipSize(file) {
  return gzipSync(readFileSync(join(astroDir, file))).length;
}

const wikiPages = findWikiPages();
if (wikiPages.length === 0) {
  console.error(
    'assert-eager-chunks: no /wiki/**/index.html page found in dist — wiki routing ' +
      'changed, or the build is incomplete. This assertion silently checked nothing for ' +
      '/wiki/* before; failing loudly instead of skipping it.',
  );
  process.exit(1);
}
const targets = [...TARGET_PAGES, ...wikiPages];
const failures = [];
let issuesEagerReport = null;

for (const rel of targets) {
  const full = join(dist, rel);
  if (!existsSync(full)) {
    failures.push(`${rel}: page not found in dist — cannot check its eager chunk graph.`);
    continue;
  }
  const html = readFileSync(full, 'utf8');
  const roots = eagerRootsForPage(html);
  const eagerSet = closure(roots, importsOf);
  const offending = findOffendingChunks(eagerSet, mermaidSet);
  if (offending.length > 0) {
    failures.push(
      `${rel}: eager chunk graph pulls in mermaid/d3 chunk(s): ${offending.join(', ')}. ` +
        `See PROJ-868 — check astro.config.mjs's manualChunks rule for the rolldown ` +
        `runtime helper / @preact/signals.`,
    );
  }
  if (rel === 'issues/index.html') {
    let total = 0;
    for (const f of eagerSet) {
      const p = join(astroDir, f);
      if (existsSync(p) && statSync(p).isFile()) total += gzipSize(f);
    }
    issuesEagerReport = { count: eagerSet.size, gzipBytes: total };
  }
}

if (issuesEagerReport) {
  console.log(
    `assert-eager-chunks: /issues eager JS = ${issuesEagerReport.count} chunks, ` +
      `${(issuesEagerReport.gzipBytes / 1024).toFixed(2)} KiB gzip`,
  );
}

if (failures.length > 0) {
  for (const f of failures) console.error(`assert-eager-chunks: FAIL — ${f}`);
  process.exit(1);
}
console.log(`assert-eager-chunks: OK (checked ${targets.length} page(s))`);
