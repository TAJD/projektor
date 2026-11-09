import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// WCAG 2.4.1 (Bypass Blocks): keyboard users must be able to skip the header and
// sidebar. The link must be the first focusable thing in <body>, and its target the
// single <main> landmark.
const base = readFileSync(join(__dirname, "Base.astro"), "utf-8");

describe("Base layout — skip link and main landmark", () => {
	it("opens <body> with a skip link to #main-content", () => {
		const afterBody = base.slice(base.indexOf("<body>"));
		const firstTag = /<(a|button|input|select|textarea|div|header|aside|main)\b[^>]*>/.exec(afterBody);
		expect(firstTag?.[0]).toContain('href="#main-content"');
	});

	it("wraps page content in one <main id=main-content> that can take focus", () => {
		expect(base).toMatch(/<main class="app-main" id="main-content" tabindex="-1">/);
		expect(base.match(/<main\b/g)).toHaveLength(1);
	});
});
