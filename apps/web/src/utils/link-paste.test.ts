import { describe, expect, it } from "vitest";
import {
	isLiteralContext,
	linkReplacement,
	markdownLink,
	pastedUrl,
	planCardInsert,
} from "./link-paste";

const URL = "https://example.com/a";

describe("pastedUrl", () => {
	it("accepts exactly one http(s) URL, trimmed", () => {
		expect(pastedUrl(`  ${URL}\n`)).toBe(URL);
		expect(pastedUrl("http://example.com")).toBe("http://example.com");
	});

	it.each(["see https://example.com", "ftp://example.com", "javascript:alert(1)", "", "https://"])(
		"rejects %j",
		(text) => {
			expect(pastedUrl(text)).toBeNull();
		}
	);
});

describe("isLiteralContext", () => {
	it("is true inside a fenced code block", () => {
		const doc = "```\ncode ";
		expect(isLiteralContext(doc, doc.length)).toBe(true);
		const closed = "```\ncode\n```\n";
		expect(isLiteralContext(closed, closed.length)).toBe(false);
	});

	it("is true inside inline code, after ( < ], and on list/quote/table lines", () => {
		for (const doc of [
			"a `code ",
			"[text](",
			"<",
			"[text]",
			"- item ",
			"1. item ",
			"> quote ",
			"| a | ",
		]) {
			expect(isLiteralContext(doc, doc.length)).toBe(true);
		}
	});

	it("is false on an empty line or after prose", () => {
		expect(isLiteralContext("", 0)).toBe(false);
		expect(isLiteralContext("Some text ", 10)).toBe(false);
	});
});

describe("planCardInsert", () => {
	it("inserts the bare URL into an empty doc", () => {
		expect(planCardInsert("", 0, URL)).toMatchObject({ insert: URL, prefix: "", suffix: "" });
	});

	it("splits a line with blank lines on both sides", () => {
		const doc = "see  here";
		const plan = planCardInsert(doc, 4, URL);
		expect(plan).toMatchObject({ prefixSplit: true, suffixSplit: true });
		expect(doc.slice(0, 4) + plan.insert + doc.slice(4)).toBe(`see \n\n${URL}\n\n here`);
	});

	it("adds only the blank line that is missing next to neighbouring paragraphs", () => {
		const doc = "above\n\nbelow";
		const plan = planCardInsert(doc, 6, URL);
		expect(plan).toMatchObject({
			prefix: "\n",
			suffix: "\n",
			prefixSplit: false,
			suffixSplit: false,
		});
		expect(doc.slice(0, 6) + plan.insert + doc.slice(6)).toBe(`above\n\n${URL}\n\nbelow`);
	});

	it("needs nothing on an empty line already surrounded by blank lines", () => {
		const doc = "a\n\n\n\nb";
		expect(planCardInsert(doc, 3, URL)).toMatchObject({ prefix: "", suffix: "" });
	});
});

describe("linkReplacement / markdownLink", () => {
	it("restores the inline text a card split apart", () => {
		const doc = "see  here";
		const plan = planCardInsert(doc, 4, URL);
		expect(doc.slice(0, 4) + linkReplacement(plan, URL, "Title") + doc.slice(4)).toBe(
			`see [Title](${URL}) here`
		);
	});

	it("keeps paragraph separation the card didn't split", () => {
		const plan = planCardInsert("above\n\nbelow", 6, URL);
		expect(linkReplacement(plan, URL, "Title")).toBe(`\n[Title](${URL})\n`);
	});

	it("escapes brackets in the title and falls back to the URL", () => {
		expect(markdownLink("A [b] c", URL)).toBe(`[A \\[b\\] c](${URL})`);
		expect(markdownLink(null, URL)).toBe(`[${URL}](${URL})`);
		expect(markdownLink("x", "https://e.com/a_(b)")).toBe("[x](https://e.com/a_%28b%29)");
	});
});
