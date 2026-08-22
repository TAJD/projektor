/**
 * Submits the docs site's sitemap URLs to IndexNow so Bing, Yandex, Seznam, and
 * Naver pick up changes without waiting for their next crawl.
 *
 * Google does not consume IndexNow — its indexing is driven separately via
 * Search Console sitemap submission (see astro.config.mjs's google-site-verification tag).
 *
 * Runs after `astro build`, once dist/sitemap-0.xml exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sitemapPath = join(here, "..", "dist", "sitemap-0.xml");

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const BASE_URL = "https://tajd.github.io/projektor";
// Not a secret: an IndexNow key only proves control of the site (by being
// reachable at <BASE_URL>/<KEY>.txt), so committing it alongside the public
// key file is fine.
const KEY = "b26e02e50344f7981441dd8c4abd5cc8";

async function main() {
  const xml = readFileSync(sitemapPath, "utf8");
  const urlList = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(BASE_URL).host,
      key: KEY,
      keyLocation: `${BASE_URL}/${KEY}.txt`,
      urlList,
    }),
  });

  if (!response.ok) {
    throw new Error(`IndexNow submission failed: ${response.status} ${response.statusText}`);
  }

  console.log(`Submitted ${urlList.length} URL(s) to IndexNow.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
