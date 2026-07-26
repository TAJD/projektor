// PROJ-431 throwaway measurement harness. Serves the built dist/ locally and
// proxies /api + /auth to the live dogfood Worker so the numbers include real
// API latency, then drives Chromium on a Lighthouse-equivalent mobile profile.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { chromium, devices } from '@playwright/test';

const ORIGIN = 'https://projektor.tajdickson.workers.dev';
const TOKEN = process.env.PROJEKTOR_API_TOKEN;
const SLUG = 'projektor';
const DIST = new URL('../../dist/', import.meta.url).pathname.replace(/^\//, '');
const PORT = 4399;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const apiTimings = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth') || url.pathname.startsWith('/mcp')) {
    const t0 = performance.now();
    try {
      const upstream = await fetch(ORIGIN + req.url, {
        method: req.method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Workspace-Slug': SLUG },
        redirect: 'manual',
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      apiTimings.push({ path: url.pathname + url.search, ms: performance.now() - t0, status: upstream.status, bytes: buf.length });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(buf);
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Pretty issue URLs have no prerendered page (getStaticPaths returns []); the Worker
  // serves the /issues/view document and the island resolves from the pathname.
  const pathname = /^\/projects\/[^/]+\/issues\/\d+\//.test(url.pathname)
    ? '/issues/view'
    : url.pathname;

  // static
  let p = normalize(join(DIST, decodeURIComponent(pathname)));
  try {
    const s = await stat(p).catch(() => null);
    if (!s || s.isDirectory()) p = join(p, 'index.html');
    const raw = await readFile(p);
    // Cloudflare serves these assets brotli/gzip-encoded; without this the mobile
    // profile measures ~3x the JS bytes that production actually ships.
    const compressible = /\.(js|css|html|json|svg)$/.test(p);
    const accepts = String(req.headers['accept-encoding'] ?? '');
    const useBr = compressible && accepts.includes('br');
    const useGz = compressible && !useBr && accepts.includes('gzip');
    const body = useBr ? brotliCompressSync(raw) : useGz ? gzipSync(raw, { level: 9 }) : raw;
    res.writeHead(200, {
      'content-type': MIME[extname(p)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...(useBr ? { 'content-encoding': 'br' } : useGz ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));

// Leading slashes get mangled by Git Bash path conversion, so args are passed
// without one and normalised here.
const TARGETS = (
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['', 'issues/view?id=49053198-9ea1-4f14-a3bf-0d1ce9766aa0', 'projects/PROJ/issues/431/x']
).map((t) => '/' + t.replace(/^\/+/, ''));

const PROFILES = {
  // Lighthouse "mobile" defaults: 1.6 Mbps down / 750 Kbps up / 150ms RTT, 4x CPU slowdown.
  'mobile (Slow 4G, 4x CPU)': { down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, latency: 150, cpu: 4, mobile: true },
  'desktop (unthrottled)': { down: -1, up: -1, latency: 0, cpu: 1, mobile: false },
};

const results = [];

for (const [profileName, prof] of Object.entries(PROFILES)) {
  for (const target of TARGETS) {
    for (let run = 0; run < 3; run++) {
      const browser = await chromium.launch();
      const ctx = await browser.newContext(
        prof.mobile
          ? { ...devices['Pixel 5'], serviceWorkers: 'allow' }
          : { viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow' },
      );
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.__lcp = null; window.__long = [];
        try {
          new PerformanceObserver((l) => { window.__lcp = l.getEntries().at(-1).startTime; })
            .observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
        try {
          new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); })
            .observe({ type: 'longtask', buffered: true });
        } catch {}
      });
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, downloadThroughput: prof.down, uploadThroughput: prof.up, latency: prof.latency,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });

      let jsBytes = 0, reqCount = 0;
      page.on('response', async (r) => {
        reqCount++;
        const cl = Number(r.headers()['content-length'] ?? 0);
        if (r.url().endsWith('.js')) jsBytes += cl;
      });

      const t0 = Date.now();
      await page.goto(`http://localhost:${PORT}${target}`, { waitUntil: 'commit' });

      // Time until real content (not the "Loading…" placeholder) is on screen.
      let contentMs = null;
      try {
        await page.waitForFunction(() => {
          const t = document.body?.innerText ?? '';
          return t.length > 120 && !/^\s*Loading…?\s*$/m.test(t.trim()) && !t.trim().startsWith('Loading');
        }, undefined, { timeout: 30000 });
        contentMs = Date.now() - t0;
      } catch { /* stayed on placeholder */ }

      await page.waitForLoadState('networkidle').catch(() => {});

      const vitals = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]));
        const res = performance.getEntriesByType('resource');
        const js = res.filter((r) => r.name.endsWith('.js'));
        const api = res.filter((r) => r.name.includes('/api/') || r.name.includes('/auth/'));
        return {
          fcp: paints['first-contentful-paint'] ?? null,
          lcp: window.__lcp ?? null,
          dcl: nav?.domContentLoadedEventEnd ?? null,
          load: nav?.loadEventEnd ?? null,
          longTasks: (window.__long ?? []).length,
          longTaskMs: (window.__long ?? []).reduce((a, d) => a + d, 0),
          jsBytes: js.reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0),
          jsDoneAt: js.length ? Math.max(...js.map((r) => r.responseEnd)) : null,
          apiFirstAt: api.length ? Math.min(...api.map((r) => r.startTime)) : null,
          apiDoneAt: api.length ? Math.max(...api.map((r) => r.responseEnd)) : null,
          apiCount: api.length,
        };
      });

      results.push({ profile: profileName, target, run, contentMs, reqCount, ...vitals });
      await browser.close();
    }
  }
}

const med = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const fmt = (n) => (n == null ? '   n/a' : `${Math.round(n)}`.padStart(6));

console.log('\n=== PROJ-431 measured page load (median of 3) ===\n');
console.log('profile                    target                       FCP    LCP    DCL  content  JSdone  api1st apidone   JSKiB  napi longTask');
for (const profile of Object.keys(PROFILES)) {
  for (const target of TARGETS) {
    const rs = results.filter((r) => r.profile === profile && r.target === target);
    if (!rs.length) continue;
    console.log(
      profile.padEnd(26) + target.slice(0, 28).padEnd(29) +
      fmt(med(rs.map((r) => r.fcp))) + fmt(med(rs.map((r) => r.lcp))) +
      fmt(med(rs.map((r) => r.dcl))) + fmt(med(rs.map((r) => r.contentMs))) +
      fmt(med(rs.map((r) => r.jsDoneAt))) + fmt(med(rs.map((r) => r.apiFirstAt))) +
      fmt(med(rs.map((r) => r.apiDoneAt))) +
      fmt(med(rs.map((r) => r.jsBytes / 1024))) + fmt(med(rs.map((r) => r.apiCount))) +
      fmt(med(rs.map((r) => r.longTaskMs))),
    );
  }
}

console.log('\n=== upstream API calls observed (ms, as seen by the proxy) ===');
const byPath = new Map();
for (const t of apiTimings) {
  const k = t.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}').split('&entityId')[0];
  if (!byPath.has(k)) byPath.set(k, []);
  byPath.get(k).push(t.ms);
}
for (const [k, v] of [...byPath.entries()].sort((a, b) => med(b[1]) - med(a[1]))) {
  console.log(`${fmt(med(v))} ms median  (n=${v.length})  ${k}`);
}

server.close();
process.exit(0);
