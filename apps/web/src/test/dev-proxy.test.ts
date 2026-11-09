import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The account menu reads /auth/me. If `astro dev` doesn't proxy /auth to the Worker,
// the header shows "Log in" even though the dev auth bypass has signed you in.
describe("astro dev proxy", () => {
	it("forwards /api, /mcp and /auth to the local Worker", () => {
		const config = readFileSync(join(__dirname, "../../astro.config.mjs"), "utf-8");
		for (const prefix of ["/api", "/mcp", "/auth"]) {
			expect(config).toContain(`'${prefix}': 'http://localhost:8787'`);
		}
	});
});
