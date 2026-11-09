import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tap-target standard: 32px buttons/selects (28px small) on desktop, 44px on phones.
// WCAG 2.5.8's 24px floor is the legal minimum; these are the comfortable defaults.
const css = readFileSync(join(__dirname, "components.css"), "utf-8");
const rule = (selector: string) => {
	const m = new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(
		css
	);
	if (!m) throw new Error(`no rule for ${selector}`);
	return m[1];
};

describe("button and select sizing", () => {
	it("gives .btn and .select-button a 32px minimum, .btn-sm 28px", () => {
		expect(rule(".btn")).toMatch(/min-height:\s*2rem/);
		expect(rule(".select-button")).toMatch(/min-height:\s*2rem/);
		expect(rule(".btn-sm")).toMatch(/min-height:\s*1\.75rem/);
	});

	it("raises both to 44px on phones", () => {
		expect(css).toMatch(
			/@media \(max-width: 640px\) \{\s*\.btn,\s*\.select-button \{\s*min-height:\s*2\.75rem;/
		);
	});

	it("outline buttons share the control border used by fields and selects", () => {
		expect(rule(".btn-outline")).toMatch(/border-color:\s*var\(--border-control\)/);
	});
});
