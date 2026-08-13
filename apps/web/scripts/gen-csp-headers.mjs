// Writes dist/_headers with the Content-Security-Policy, as a post-build step.
//
// PROJ-645. Two constraints ruled out the obvious mechanisms, both measured rather than
// assumed:
//
//   Astro's `security.csp` emits a <meta> tag and appends a SHA-256 for every <style>
//   block it inlines — including its own `astro-island{display:contents}`, which no
//   config setting removes. CSP ignores 'unsafe-inline' in any directive that also
//   carries a hash, and mermaid (a ~5.4 KB <style> per diagram) and CodeMirror (its
//   themes) both inject styles at runtime that no build-time hash can cover. With it
//   enabled, mermaid renders an unstyled diagram and mounting the editor logs 15
//   violations. There is no astro configuration where the styles survive.
//
//   A Worker response header cannot reach these pages either: wrangler.toml sets
//   run_worker_first = ["/api/*", "/mcp/*", "/wiki"], so every other HTML route is
//   served asset-first by Cloudflare's edge and the Worker never runs. That is why
//   the CSP idiom in apps/api/src/routes/files.ts does not generalise here.
//
// So the policy ships as a real response header via the assets `_headers` file, with
// the inline-script hashes computed here from the built HTML. A header also buys
// frame-ancestors, which a <meta> CSP cannot express at all.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const htmlFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return entry.endsWith('.html') ? [full] : [];
  });

// Astro emits its hydration runtime and a few of our own bootstrap snippets inline;
// each needs a hash or `script-src 'self'` would refuse it and the app would not boot.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const hashes = new Set();
const pages = htmlFiles(dist);
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
}

const policy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`,
  // Deliberately loose, and it is the half that cannot be tightened: see the header
  // comment. Styles set through the CSSOM (how preact applies `style={{...}}`) are not
  // policed by CSP at all, so this only concedes <style> elements and
  // setAttribute('style', ...) — not the script execution that XSS actually needs.
  "style-src 'self' 'unsafe-inline'",
].join('; ');

writeFileSync(join(dist, '_headers'), `/*\n  Content-Security-Policy: ${policy}\n`, 'utf8');

console.log(`gen-csp-headers: ${hashes.size} inline-script hashes across ${pages.length} pages`);
if (hashes.size === 0) {
  console.error('gen-csp-headers: no inline scripts found — the regex or build layout changed.');
  process.exit(1);
}
