// PROJ-431 throwaway: exercises the interactive changes in a real browser at both
// mobile and desktop widths. Reuses the static+proxy server from perf-measure.mjs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, devices } from '@playwright/test';

const ORIGIN = 'https://projektor.tajdickson.workers.dev';
const TOKEN = process.env.PROJEKTOR_API_TOKEN;
const DIST = new URL('../../dist/', import.meta.url).pathname.replace(/^\//, '');
const PORT = 4400;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (/^\/(api|auth|mcp)/.test(url.pathname)) {
    const up = await fetch(ORIGIN + req.url, {
      method: req.method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Workspace-Slug': 'projektor', ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }),
      redirect: 'manual',
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    return res.end(buf);
  }
  const pathname = /^\/projects\/[^/]+\/issues\/\d+\//.test(url.pathname) ? '/issues/view' : url.pathname;
  let p = normalize(join(DIST, decodeURIComponent(pathname)));
  try {
    const s = await stat(p).catch(() => null);
    if (!s || s.isDirectory()) p = join(p, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(PORT, r));

const ISSUE = '/issues/view?id=49053198-9ea1-4f14-a3bf-0d1ce9766aa0';
const results = [];
const check = (profile, name, pass, detail = '') => {
  results.push({ profile, name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

for (const [profile, ctxOpts] of [
  ['mobile 375x812', { ...devices['Pixel 5'] }],
  ['desktop 1440x900', { viewport: { width: 1440, height: 900 } }],
]) {
  console.log(`\n=== ${profile} ===`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const isMobile = profile.startsWith('mobile');

  await page.goto(`http://localhost:${PORT}${ISSUE}`);
  await page.waitForSelector('article', { timeout: 30000 });

  // ── comment textarea: 16px on mobile so iOS doesn't zoom on focus ──
  const ta = page.locator('textarea[placeholder="Add a comment…"]');
  await ta.waitFor();
  const taFont = await ta.evaluate((el) => getComputedStyle(el).fontSize);
  check(profile, 'comment textarea font-size', isMobile ? taFont === '16px' : taFont === '14px', taFont);

  // ── draft persistence ──
  await ta.fill('a half-typed thought from PROJ-431');
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('article', { timeout: 30000 });
  const restored = await page.locator('textarea[placeholder="Add a comment…"]').inputValue();
  check(profile, 'comment draft survives reload', restored === 'a half-typed thought from PROJ-431', JSON.stringify(restored.slice(0, 40)));

  await page.locator('textarea[placeholder="Add a comment…"]').fill('');
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('article', { timeout: 30000 });
  const cleared = await page.locator('textarea[placeholder="Add a comment…"]').inputValue();
  check(profile, 'cleared draft does not come back', cleared === '', JSON.stringify(cleared));

  // ── lazy editor: fallback textarea first, then CodeMirror ──
  await page.route('**/_astro/MarkdownEditor*.js', async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  await page.locator('button[title="Edit description"]').click();
  const fallback = await page.locator('textarea[aria-label="Markdown editor"]').isVisible().catch(() => false);
  check(profile, 'fallback textarea shown while editor chunk loads', fallback);

  if (fallback) {
    await page.locator('textarea[aria-label="Markdown editor"]').fill('typed before CodeMirror arrived');
  }
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  const adopted = (await page.locator('.cm-content').innerText()).includes('typed before CodeMirror arrived');
  check(profile, 'CodeMirror adopts text typed into the fallback', adopted);

  const cmFont = await page.locator('.cm-content').evaluate((el) => getComputedStyle(el).fontSize);
  check(profile, 'editor font-size', isMobile ? cmFont === '16px' : cmFont === '14px', cmFont);

  // ── toolbar tap targets ──
  const boxes = await page.locator('button[title="Bold (Ctrl+B)"], button[title="Heading 1"], button[title="Link"]').evaluateAll(
    (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
  );
  const okTargets = isMobile ? boxes.every((b) => b.w >= 44 && b.h >= 44) : boxes.every((b) => b.h < 44);
  check(profile, isMobile ? 'toolbar buttons are >=44px touch targets' : 'toolbar stays compact on desktop', okTargets, JSON.stringify(boxes));

  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
server.close();
process.exit(failed.length ? 1 : 0);
