import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
	it("lowercases the input", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it("replaces spaces with hyphens", () => {
		expect(slugify("my page title")).toBe("my-page-title");
	});

	it("collapses multiple spaces into a single hyphen", () => {
		expect(slugify("foo   bar")).toBe("foo-bar");
	});

	it("replaces non-alphanumeric characters with hyphens", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
	});

	it("strips leading hyphens", () => {
		expect(slugify("!leading special")).toBe("leading-special");
	});

	it("strips trailing hyphens", () => {
		expect(slugify("trailing special!")).toBe("trailing-special");
	});

	it("strips both leading and trailing hyphens", () => {
		expect(slugify("!both ends!")).toBe("both-ends");
	});

	it("returns empty string for empty input", () => {
		expect(slugify("")).toBe("");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(slugify("   ")).toBe("");
	});

	it("returns empty string for input with only special characters", () => {
		expect(slugify("!!!")).toBe("");
	});

	it("is idempotent — slugifying a slug produces the same slug", () => {
		const first = slugify("My Page Title");
		const second = slugify(first);
		expect(second).toBe(first);
	});

	it("preserves digits", () => {
		expect(slugify("Page 42")).toBe("page-42");
	});

	it("handles unicode letters by stripping them (only ascii kept)", () => {
		expect(slugify("café")).toBe("caf");
	});

	it("handles a single word with no special characters", () => {
		expect(slugify("hello")).toBe("hello");
	});

	it("collapses consecutive special chars into one hyphen", () => {
		expect(slugify("a---b")).toBe("a-b");
	});
});
