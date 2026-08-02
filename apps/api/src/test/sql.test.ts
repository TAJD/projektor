import { describe, expect, it } from "vitest";
import { inChunks, sanitizeFtsQuery } from "../services/sql";

describe("sanitizeFtsQuery (PROJ-518)", () => {
	it("wraps each whitespace-separated token in double quotes", () => {
		expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"');
	});

	it("neutralizes FTS5 query syntax by treating it as literal text", () => {
		expect(sanitizeFtsQuery("foo AND bar OR NOT baz*")).toBe('"foo" "AND" "bar" "OR" "NOT" "baz*"');
	});

	it("escapes embedded double quotes so they can't break out of the phrase", () => {
		expect(sanitizeFtsQuery('say "hi"')).toBe('"say" """hi"""');
	});

	it("drops tokens with no word characters", () => {
		expect(sanitizeFtsQuery("--- ??? hello")).toBe('"hello"');
	});

	it("returns an empty string for blank input", () => {
		expect(sanitizeFtsQuery("   ")).toBe("");
	});
});

describe("inChunks", () => {
	it("returns an empty array without calling op for an empty input", async () => {
		let called = false;
		const result = await inChunks([], async () => {
			called = true;
			return [];
		});
		expect(result).toEqual([]);
		expect(called).toBe(false);
	});

	it("makes a single call when the input is well under the D1 bound-parameter cap", async () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		const chunks: number[][] = [];
		const result = await inChunks(items, async (chunk) => {
			chunks.push(chunk);
			return chunk.map((n) => n * 2);
		});
		expect(chunks).toHaveLength(1);
		expect(result).toEqual(items.map((n) => n * 2));
	});

	it("splits a 250-item array into 3 chunks, each at or under D1's 100 bound-parameter cap", async () => {
		const items = Array.from({ length: 250 }, (_, i) => i);
		const chunkSizes: number[] = [];
		const result = await inChunks(items, async (chunk) => {
			chunkSizes.push(chunk.length);
			return chunk;
		});

		expect(chunkSizes).toHaveLength(3);
		for (const size of chunkSizes) {
			expect(size).toBeLessThanOrEqual(100);
		}
		expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(250);
		// concatenation preserves order and every item exactly once
		expect(result).toEqual(items);
	});

	it("chunks exactly at a 100-item boundary into more than one call", async () => {
		const items = Array.from({ length: 100 }, (_, i) => i);
		const chunkSizes: number[] = [];
		await inChunks(items, async (chunk) => {
			chunkSizes.push(chunk.length);
			return [];
		});
		expect(chunkSizes.length).toBeGreaterThan(1);
		for (const size of chunkSizes) {
			expect(size).toBeLessThanOrEqual(100);
		}
	});

	it("supports mutation-style callbacks that return no rows", async () => {
		const items = Array.from({ length: 150 }, (_, i) => i);
		const seen: number[] = [];
		const result = await inChunks(items, async (chunk) => {
			seen.push(...chunk);
			return [];
		});
		expect(result).toEqual([]);
		expect(seen).toEqual(items);
	});
});
