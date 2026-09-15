import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deriveBrandMark } from "../routes/config";

describe("GET /api/config/brand", () => {
	it("reflects configured BRAND_* vars, deriving the mark and defaulting unset fields (open, no auth)", async () => {
		const res = await SELF.fetch("http://localhost/api/config/brand");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "Test Brand",
			mark: "T",
			accent: "#123456",
			onAccent: null,
			logoUrl: null,
		});
	});
});

describe("deriveBrandMark", () => {
	it("uppercases the first character of the brand name", () => {
		expect(deriveBrandMark("acme")).toBe("A");
	});

	it("falls back to P for an empty or whitespace-only name", () => {
		expect(deriveBrandMark("   ")).toBe("P");
		expect(deriveBrandMark("")).toBe("P");
	});
});
