// Asserts the *built* service worker, not the config.
//
// PROJ-430 was caused by a Workbox default that the config never mentions:
// vite-plugin-pwa hard-codes navigateFallback: 'index.html' and merges with
// Object.assign, so the generated sw.js can register a cache-first navigation route
// that no line of astro.config.mjs asked for. That is only visible after a build,
// which is why this runs as a post-build step rather than as a vitest case (CI runs
// the unit tests before the build, so a dist-reading test would just skip).
//
// PROJ-431 adds the precache budget: the install payload had grown to 4.17 MiB of
// mostly lazy vendor chunks.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const swPath = join(dist, 'sw.js');

const PRECACHE_BUDGET_BYTES = 1024 * 1024;

const failures = [];
const notes = [];

if (!existsSync(swPath)) {
  console.error(`assert-sw: ${swPath} not found — run the build first.`);
  process.exit(1);
}

const sw = readFileSync(swPath, 'utf8');

// ── PROJ-430 invariants ──────────────────────────────────────────────────────
// Navigations must reach the network, or Cloudflare Access can never re-challenge
// an expired session and the app reload-loops.
for (const marker of ['NavigationRoute', 'createHandlerBoundToURL']) {
  if (sw.includes(marker)) {
    failures.push(
      `sw.js contains ${marker}: navigations would be answered from cache. ` +
        `See PROJ-430 — this caused an all-night reload loop. If reintroducing an ` +
        `offline shell deliberately, it must be NetworkFirst with ` +
        `cacheableResponse: { statuses: [200] } so Access's login redirect is never cached.`,
    );
  }
}

if (!sw.includes('NetworkOnly')) {
  failures.push('sw.js has no NetworkOnly handler — /api and /mcp must never be cached.');
}
if (!/\/\^\\\/\(\?:api\|mcp\)\\\//.test(sw)) {
  failures.push('sw.js has no /^\\/(?:api|mcp)\\// route — API traffic may be cached.');
}

// ── PROJ-431 precache budget ─────────────────────────────────────────────────
// Workbox emits the manifest minified as `url:"_astro/foo.js",revision:...` —
// entries are relative and unquoted-key, so match that shape specifically.
const urls = [...new Set([...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]))];
if (urls.length === 0) {
  failures.push(
    'could not parse any precache entries out of sw.js — the manifest format changed, ' +
      'so the budget check below is not actually checking anything. Fix the parser.',
  );
}
let total = 0;
const entries = [];
for (const u of urls) {
  const p = join(dist, u.replace(/^\//, ''));
  if (!existsSync(p)) continue;
  const size = statSync(p).size;
  total += size;
  entries.push({ u, size });
}

if (urls.some((u) => u.endsWith('.html'))) {
  failures.push('sw.js precaches HTML — navigations must reach the network (PROJ-430).');
}

entries.sort((a, b) => b.size - a.size);
notes.push(
  `precache: ${entries.length} entries, ${(total / 1024 / 1024).toFixed(2)} MiB ` +
    `(budget ${(PRECACHE_BUDGET_BYTES / 1024 / 1024).toFixed(2)} MiB)`,
);
for (const e of entries.slice(0, 5)) {
  notes.push(`  ${(e.size / 1024).toFixed(1).padStart(8)} KiB  ${e.u}`);
}

if (total > PRECACHE_BUDGET_BYTES) {
  failures.push(
    `precache is ${(total / 1024 / 1024).toFixed(2)} MiB, over the ` +
      `${(PRECACHE_BUDGET_BYTES / 1024 / 1024).toFixed(2)} MiB budget. Heavy chunks that are ` +
      `dynamically imported (mermaid, cytoscape, katex, the editor) belong in globIgnores ` +
      `in astro.config.mjs — they still load on demand.`,
  );
}

for (const n of notes) console.log(`assert-sw: ${n}`);
if (failures.length) {
  for (const f of failures) console.error(`assert-sw: FAIL — ${f}`);
  process.exit(1);
}
console.log('assert-sw: OK');
