import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const webPublic = join(here, "..", "..", "web", "public");
const docsPublic = join(here, "..", "public");

const ACCENT = process.env.BRAND_ACCENT ?? "#007a87";
const ON_ACCENT = process.env.BRAND_ON_ACCENT ?? "#ffffff";
const MARK = process.env.BRAND_MARK ?? "P";
const FONT = process.env.BRAND_FONT ?? "'IBM Plex Sans', system-ui, sans-serif";

function faviconSvg(size) {
	const rx = size * 0.1875;
	const fontSize = size * 0.5625;
	const textY = size * 0.6875;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${ACCENT}"/>
  <text x="${size / 2}" y="${textY}" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${ON_ACCENT}" text-anchor="middle">${MARK}</text>
</svg>
`;
}

const svg32 = faviconSvg(32);
writeFileSync(join(webPublic, "favicon.svg"), svg32);
writeFileSync(join(docsPublic, "favicon.svg"), svg32);

for (const size of [192, 512]) {
	const png = await sharp(Buffer.from(faviconSvg(size))).png().toBuffer();
	writeFileSync(join(webPublic, `icon-${size}.png`), png);
}

console.log("Wrote favicon.svg (web + docs) and web/icon-192.png, web/icon-512.png");
