import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contrast floors for the tokens the UX audit flagged. Values are read from tokens.css
// so a later palette tweak can't silently regress them.
//   WCAG 1.4.11 (non-text, ≥3:1): edges of text fields and selects, the switch track.
//   WCAG 1.4.3  (text, ≥4.5:1):   priority chip text on its own tinted chip.

const css = readFileSync(join(__dirname, "tokens.css"), "utf-8");
const token = (name: string): string => {
	const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
	if (!m) throw new Error(`missing --${name}`);
	return m[1].trim();
};

type RGB = [number, number, number];

function parseColor(v: string): { rgb: RGB; alpha: number } {
	// Expand #rgb shorthand to #rrggbb.
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
	if (short) v = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	let m = /^#([0-9a-f]{6})$/i.exec(v);
	if (m) {
		const n = Number.parseInt(m[1], 16);
		return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
	}
	m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(v);
	if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: +m[4] };
	m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
	if (m) return { rgb: oklchToSrgb(+m[1] / 100, +m[2], +m[3]), alpha: 1 };
	throw new Error(`unsupported colour ${v}`);
}

function oklchToSrgb(L: number, C: number, h: number): RGB {
	const a = C * Math.cos((h * Math.PI) / 180);
	const b = C * Math.sin((h * Math.PI) / 180);
	const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
	return lin.map((c) => {
		const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, v)) * 255);
	}) as RGB;
}

const over = (fg: { rgb: RGB; alpha: number }, bg: RGB): RGB =>
	fg.rgb.map((c, i) => Math.round(c * fg.alpha + bg[i] * (1 - fg.alpha))) as RGB;

function luminance([r, g, b]: RGB): number {
	const f = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe.each(["light", "dark"])("%s theme contrast floors", (theme) => {
	const bg = parseColor(token(`${theme}-bg`)).rgb;
	const surface = parseColor(token(`${theme}-surface`)).rgb;

	it("control borders are ≥3:1 on both page and surface (WCAG 1.4.11)", () => {
		const border = parseColor(token(`${theme}-border-control`)).rgb;
		expect(contrast(border, bg)).toBeGreaterThanOrEqual(3);
		expect(contrast(border, surface)).toBeGreaterThanOrEqual(3);
	});

	it.each(["urgent", "high", "low"])(
		"%s priority chip text is ≥4.5:1 on its tinted chip (WCAG 1.4.3)",
		(level) => {
			const chip = over(parseColor(token(`${theme}-priority-${level}-bg`)), bg);
			const text = parseColor(token(`${theme}-priority-${level}-text`)).rgb;
			expect(contrast(text, chip)).toBeGreaterThanOrEqual(4.5);
		}
	);

	it("danger text is ≥4.5:1 on the danger tint (WCAG 1.4.3)", () => {
		const tint = over(parseColor(token(`${theme}-danger-bg`)), bg);
		const text = parseColor(token(`${theme}-danger-text`)).rgb;
		expect(contrast(text, tint)).toBeGreaterThanOrEqual(4.5);
	});

	it("text on the accent colour (--on-accent) is ≥4.5:1 (WCAG 1.4.3)", () => {
		const accent = parseColor(token(`${theme}-accent`)).rgb;
		const onAccent = parseColor(token(`${theme}-on-accent`)).rgb;
		expect(contrast(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
	});
});
