import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync(join(__dirname, "tokens.css"), "utf-8");

describe("tokens.css — brand-derived tokens stay derived from --accent (PROJ-754)", () => {
	it("never reintroduces the hardcoded indigo/blue literals that accent-derived tokens replaced", () => {
		expect(tokensCss).not.toContain("rgba(37, 99, 235");
		expect(tokensCss).not.toContain("rgba(129, 140, 248");
		expect(tokensCss).not.toContain("rgba(79, 70, 229");
	});
});
