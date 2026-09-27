// Pure graph logic for apps/web/scripts/assert-eager-chunks.mjs (PROJ-868), split out so
// it can be unit-tested without a real `dist/` build (see
// apps/web/src/test/eager-chunk-graph.test.ts).

import { basename } from 'node:path';

// Matches only `from"./x.js"` / `import"./x.js"` (static ESM import forms rolldown
// emits) — NOT `import("./x.js")` (dynamic: has a `(` in between) — so a lazy island's
// own dynamic import of a heavy chunk is correctly not followed.
const STATIC_IMPORT_RE = /(?:from|import)"(\.\/[^"]+\.js)"/g;

/** @param {string} source */
export function parseStaticImports(source) {
  const deps = new Set();
  for (const m of source.matchAll(STATIC_IMPORT_RE)) deps.add(basename(m[1]));
  return deps;
}

/** @param {Map<string,string>} chunkContents fileName -> source text */
export function buildImportGraph(chunkContents) {
  const importsOf = new Map();
  for (const [file, src] of chunkContents) importsOf.set(file, parseStaticImports(src));
  return importsOf;
}

/**
 * @param {Iterable<string>} roots
 * @param {Map<string,Set<string>>} importsOf
 */
export function closure(roots, importsOf) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const f = queue.pop();
    if (seen.has(f) || !importsOf.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf.get(f)) queue.push(dep);
  }
  return seen;
}

/**
 * Eager roots for one built page: client:load AND client:idle islands (idle still fires
 * during/right after page load via requestIdleCallback — it's not gated on user action
 * or scroll the way client:visible is, so it counts as part of the initial load), plus
 * directly-loaded module scripts.
 */
export function eagerRootsForPage(html) {
  const roots = new Set();
  for (const m of html.matchAll(/<astro-island\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\bclient="(?:load|idle)"/.test(tag)) continue; // client:visible defers — not eager
    const compUrl = tag.match(/component-url="([^"]+)"/)?.[1];
    const rendererUrl = tag.match(/renderer-url="([^"]+)"/)?.[1];
    if (compUrl) roots.add(basename(compUrl));
    if (rendererUrl) roots.add(basename(rendererUrl));
  }
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) {
    roots.add(basename(m[1]));
  }
  return roots;
}

// See apps/web/scripts/assert-eager-chunks.mjs for why these are excluded even when
// technically reachable from mermaid's chunk graph.
export const BENIGN_SHARED_RUNTIME = /^(rolldown-runtime|preload-helper|markdown)\./;

/**
 * @param {Set<string>} eagerSet
 * @param {Set<string>} mermaidSet
 */
export function findOffendingChunks(eagerSet, mermaidSet) {
  return [...eagerSet].filter((f) => mermaidSet.has(f) && !BENIGN_SHARED_RUNTIME.test(f));
}
