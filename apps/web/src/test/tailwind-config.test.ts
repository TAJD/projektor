import { describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config.mjs";

// PROJ-603: `.prose` sets `overflow-x-auto` for wide code blocks (IssueDetailParts.tsx
// et al.), which per the CSS overflow spec forces the *other* axis to `auto` too — turning
// the whole prose box into a scrollport. Typography's default 1.625em <ol> marker gutter
// is too narrow for this app's font, so an outside-position marker numeral can render a
// few px past it and get clipped at the scrollport's left edge ("1." rendering as "L.").
describe("tailwind typography config (PROJ-603)", () => {
	it("widens the <ol> marker gutter so numerals don't spill past the prose scrollport", () => {
		const typography = tailwindConfig.theme?.extend?.typography;
		expect(typeof typography).toBe("function");
		const theme = (typography as () => { DEFAULT: { css: { ol: { paddingInlineStart: string } } } })();
		expect(theme.DEFAULT.css.ol.paddingInlineStart).toBe("2.25em");
	});
});
