import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync(join(__dirname, "tokens.css"), "utf-8");

const BRAND_DERIVED_PROPERTIES = [
	"priority-medium-text",
	"priority-medium-bg",
	"priority-medium-solid",
	"status-in-progress",
	"sprint-active-bg",
	"sprint-active-border",
	"dropzone-bg",
	"sprint-notice-bg",
	"sprint-notice-border",
	"velocity-bar-bg",
	"chart-seq-1",
	"chart-seq-2",
	"chart-seq-3",
	"chart-seq-4",
];

describe("tokens.css — brand-derived tokens stay derived from --accent (PROJ-754)", () => {
	it("never reintroduces the hardcoded indigo/blue literals that accent-derived tokens replaced", () => {
		expect(tokensCss).not.toContain("rgba(37, 99, 235");
		expect(tokensCss).not.toContain("rgba(129, 140, 248");
		expect(tokensCss).not.toContain("rgba(79, 70, 229");
	});

	it.each(BRAND_DERIVED_PROPERTIES)(
		"--light-%s and --dark-%s reference their theme's --accent, not a literal color",
		(name) => {
			const lightMatch = /--light-([a-z0-9-]+):\s*([^;]+);/g;
			const darkMatch = /--dark-([a-z0-9-]+):\s*([^;]+);/g;

			const findValue = (regex: RegExp, propName: string) => {
				for (const m of tokensCss.matchAll(regex)) {
					if (m[1] === propName) return m[2];
				}
				return undefined;
			};

			const lightValue = findValue(lightMatch, name);
			const darkValue = findValue(darkMatch, name);

			expect(lightValue, `--light-${name} should be declared`).toBeDefined();
			expect(darkValue, `--dark-${name} should be declared`).toBeDefined();
			expect(lightValue).toContain("var(--light-accent)");
			expect(darkValue).toContain("var(--dark-accent)");
		}
	);
});
