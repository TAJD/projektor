/**
 * Renders the site-wide social share card at public/og.png (1200x630), used
 * as og:image/twitter:image for every docs page (astro.config.mjs head).
 *
 * Static output — rerun manually if the brand palette or copy changes;
 * not part of the build since the image itself is content-independent.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "public", "og.png");

const WIDTH = 1200;
const HEIGHT = 630;

const ACCENT = process.env.BRAND_ACCENT ?? "#007a87";
const ON_ACCENT = process.env.BRAND_ON_ACCENT ?? "#ffffff";
const ACCENT_TINT = process.env.BRAND_ACCENT_TINT ?? "#7dd3da";
const MARK = process.env.BRAND_MARK ?? "P";
const MARK_FONT = process.env.BRAND_FONT ?? "'IBM Plex Sans', system-ui, sans-serif";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#0d1117"/>
  <rect x="80" y="80" width="64" height="64" rx="14" fill="${ACCENT}"/>
  <text x="103" y="129" font-family="${MARK_FONT}" font-size="40" font-weight="700" fill="${ON_ACCENT}" text-anchor="middle">${MARK}</text>
  <text x="80" y="260" font-family="system-ui, sans-serif" font-size="72" font-weight="700" fill="#f3f5f9">Projektor</text>
  <text x="80" y="330" font-family="system-ui, sans-serif" font-size="34" fill="${ACCENT_TINT}">AI-native project management on Cloudflare</text>
  <text x="80" y="420" font-family="system-ui, sans-serif" font-size="28" fill="#94a3b8">
    <tspan x="80" dy="0">A self-hosted issue tracker and wiki where every action</tspan>
    <tspan x="80" dy="40">a person takes in the browser, an agent takes over MCP.</tspan>
  </text>
  <rect x="80" y="520" width="64" height="6" fill="${ACCENT}"/>
</svg>
`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPath, png);
console.log(`Wrote OG image to ${outPath}`);
