import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// PROJ-861: the committed woff2 must actually be the subset, not a re-added full font,
// and the @font-face declarations that serve it must carry unicode-range so browsers
// only fetch it for the code points it supports.
//
// Paths are relative to `apps/web` (vitest's root), not to this file, so this test
// runs the same way regardless of how vitest resolves test-file URLs.
const WEB_ROOT = process.cwd();
const FONT_PATH = join(WEB_ROOT, "public/fonts/MonaspaceNeon-Variable.woff2");
const BASE_LAYOUT_PATH = join(WEB_ROOT, "src/layouts/Base.astro");
const SHARE_VIEW_PATH = join(WEB_ROOT, "src/pages/share/view.astro");

const BUDGET_BYTES = 60 * 1024;

// The `name` table of a WOFF2 font is stored verbatim in the single brotli-compressed
// data block (only glyf/loca get WOFF2's special transform), so decompressing that block
// and scanning the raw bytes finds every name-table string without needing a full
// WOFF2/SFNT parser. The exact start offset of the compressed block isn't worth deriving
// from the header by hand (the header's own version fields don't match the on-disk
// values in a way that's safe to hard-code), so this tries every plausible offset near
// the end of the file and keeps the first one that actually decompresses to something
// name-table-sized.
function decompressWoff2Data(buf: Buffer): Buffer {
	for (let start = 40; start < Math.min(300, buf.length); start++) {
		try {
			const out = brotliDecompressSync(buf.subarray(start));
			if (out.length > 1000) return out;
		} catch {
			// not the right offset — keep scanning
		}
	}
	throw new Error("could not locate/decompress the WOFF2 data block");
}

function utf16be(s: string): Buffer {
	const b = Buffer.alloc(s.length * 2);
	for (let i = 0; i < s.length; i++) {
		b[i * 2] = s.charCodeAt(i) >> 8;
		b[i * 2 + 1] = s.charCodeAt(i) & 0xff;
	}
	return b;
}

// Codepoints the UI actually renders with this font — one per new range added in the
// PROJ-861 follow-up review, plus the original Latin/box-drawing baseline. A cmap gap
// here means a browser silently falls back to the next font in the stack for that glyph.
const REQUIRED_CODEPOINTS: Record<string, number> = {
	"A (Basic Latin)": 0x0041,
	"é (Latin-1 Supplement)": 0x00e9,
	"Ā (Latin Extended-A)": 0x0100,
	"€ (currency)": 0x20ac,
	"‘ (General Punctuation)": 0x2018,
	"← (Arrows)": 0x2190,
	"≠ (Mathematical Operators)": 0x2260,
	"─ (Box Drawing)": 0x2500,
	"█ (Block Elements)": 0x2588,
	"■ (Geometric Shapes)": 0x25a0,
	"✓ check mark": 0x2713,
	"✕ multiplication x": 0x2715,
	"✗ ballot x": 0x2717,
};

// Reading the binary cmap subtable by hand isn't worth it here — fonttools (already a
// hard requirement to regenerate this font at all, see subset-monaspace.mjs) does it in
// one line. If it's not installed in whatever environment runs this test, skip rather
// than fail the whole suite over a missing system dependency unrelated to the code.
const fontToolsAvailable =
	spawnSync("python3", ["-c", "import fontTools"], { stdio: "ignore" }).status === 0;

function getCmapCodepoints(fontPath: string): Set<number> {
	const result = spawnSync(
		"python3",
		[
			"-c",
			"import sys,json\n" +
				"from fontTools.ttLib import TTFont\n" +
				"f = TTFont(sys.argv[1])\n" +
				"print(json.dumps(sorted(f.getBestCmap().keys())))\n",
			fontPath,
		],
		{ encoding: "utf8" }
	);
	if (result.status !== 0) {
		throw new Error(`fonttools cmap read failed: ${result.stderr}`);
	}
	return new Set(JSON.parse(result.stdout));
}

describe("Projektor Mono / Monaspace Neon subset (PROJ-861)", () => {
	it("committed woff2 is at or under the 60 KB budget", () => {
		const size = statSync(FONT_PATH).size;
		expect(size).toBeLessThanOrEqual(BUDGET_BYTES);
		// Sanity: a subset that regressed all the way back to the original 510,832 B font
		// would still pass a naive "file exists" check — pin it well below that too.
		expect(size).toBeLessThan(100 * 1024);
	});

	it("woff2 header identifies it as a real WOFF2 font (not an empty/corrupt file)", () => {
		const buf = readFileSync(FONT_PATH);
		expect(buf.length).toBeGreaterThan(0);
		expect(buf.subarray(0, 4).toString("ascii")).toBe("wOF2");
	});

	it("name table no longer contains the Reserved Font Name 'Monaspace'", () => {
		// SIL OFL 1.1 forbids a Modified Version (this subset is one) from using the
		// upstream Reserved Font Name — see apps/web/scripts/rename-font-names.py.
		const buf = readFileSync(FONT_PATH);
		const data = decompressWoff2Data(buf);
		expect(data.includes(Buffer.from("Monaspace", "ascii"))).toBe(false);
		expect(data.includes(utf16be("Monaspace"))).toBe(false);
		// And it actually got renamed, not just stripped to nothing.
		expect(data.includes(utf16be("Projektor"))).toBe(true);
	});

	(fontToolsAvailable ? it : it.skip)("cmap covers every required-glyph codepoint", () => {
		const cmap = getCmapCodepoints(FONT_PATH);
		const missing = Object.entries(REQUIRED_CODEPOINTS)
			.filter(([, cp]) => !cmap.has(cp))
			.map(([label, cp]) => `${label} U+${cp.toString(16).toUpperCase()}`);
		expect(missing, `missing glyphs: ${missing.join(", ")}`).toEqual([]);
	});

	for (const [label, path] of [
		["Base.astro", BASE_LAYOUT_PATH],
		["share/view.astro", SHARE_VIEW_PATH],
	] as const) {
		it(`${label} declares Projektor Mono's @font-face with a unicode-range`, () => {
			const src = readFileSync(path, "utf8");
			const match = src.match(/@font-face\s*{[^}]*font-family:\s*'Projektor Mono'[^}]*}/s);
			expect(match, `expected an @font-face block for 'Projektor Mono' in ${label}`).toBeTruthy();
			const block = match?.[0];
			expect(block).toMatch(/unicode-range:\s*U\+/);
			// Spot-check that the newly-added ranges actually made it into the CSS, not
			// just the subsetting script.
			expect(block).toMatch(/U\+2190-21FF/); // Arrows
			expect(block).toMatch(/U\+2200-22FF/); // Mathematical Operators
			expect(block).toMatch(/U\+25A0-25FF/); // Geometric Shapes
			expect(block).toMatch(/U\+20AC/); // Euro sign
		});
	}
});
