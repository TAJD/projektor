import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// White on the dark theme's bright accent is 2.3:1. Text on bg-accent must use
// text-on-accent, which each theme sets to a colour that passes (tokens.contrast.test.ts).
function tsxFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = join(dir, e.name);
		if (e.isDirectory()) return tsxFiles(full);
		return e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx") ? [full] : [];
	});
}

describe("islands never put text-white on the accent colour", () => {
	it("uses text-on-accent instead", () => {
		const offenders = tsxFiles(__dirname).filter((f) =>
			/bg-accent[^"`']*text-white|text-white[^"`']*bg-accent/.test(readFileSync(f, "utf-8"))
		);
		expect(offenders).toEqual([]);
	});
});
