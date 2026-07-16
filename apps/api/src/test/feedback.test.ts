import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("feedback migration", () => {
	it("creates feedback_sources and feedback tables", async () => {
		const src = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_sources'"
		).first<{ name: string }>();
		expect(src?.name).toBe("feedback_sources");

		const fb = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'"
		).first<{ name: string }>();
		expect(fb?.name).toBe("feedback");
	});
});
