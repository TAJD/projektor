// Base.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead
// (see Base.mobile-viewport.test.ts for the same pattern).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "Base.astro"), "utf-8");
const configSource = readFileSync(join(__dirname, "../../astro.config.mjs"), "utf-8");

describe("Base layout — PWA service worker registration (PROJ-418)", () => {
	it("registers the service worker via the virtual:pwa-register module", () => {
		expect(source).toMatch(/import\s*\{\s*registerSW\s*\}\s*from\s*['"]virtual:pwa-register['"]/);
		expect(source).toMatch(/registerSW\(/);
	});

	it("disables vite-plugin-pwa's own (non-functional-on-Astro) auto-injection", () => {
		expect(configSource).toMatch(/injectRegister:\s*null/);
	});
});
