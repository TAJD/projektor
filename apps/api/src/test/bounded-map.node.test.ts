import { describe, expect, it } from "vitest";
import { ISOLATE_CACHE_MAX_ENTRIES, setBounded } from "../lib/bounded-map";

describe("setBounded (PROJ-874 item 3)", () => {
	it("never grows past the cap and evicts the least recently written key", () => {
		const map = new Map<number, number>();
		for (let i = 0; i < ISOLATE_CACHE_MAX_ENTRIES + 250; i++) setBounded(map, i, i);
		expect(map.size).toBe(ISOLATE_CACHE_MAX_ENTRIES);
		expect(map.has(0)).toBe(false);
		expect(map.has(249)).toBe(false);
		expect(map.has(250)).toBe(true);
	});

	it("re-writing a key moves it to the newest slot", () => {
		const map = new Map<string, number>();
		setBounded(map, "a", 1, 3);
		setBounded(map, "b", 2, 3);
		setBounded(map, "c", 3, 3);
		setBounded(map, "a", 4, 3);
		setBounded(map, "d", 5, 3);
		expect([...map.keys()]).toEqual(["c", "a", "d"]);
		expect(map.get("a")).toBe(4);
	});
});
