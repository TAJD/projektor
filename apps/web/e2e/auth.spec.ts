/**
 * PROJ-222: E2E coverage for the auth/login flow.
 *
 * Tests:
 *  1. GET /auth/me returns the authenticated user + their workspaces
 *     (dev-bypass auth on the target deployment).
 *  2. GET /auth/login redirects (302) to the requested (same-origin) redirect_url,
 *     letting Cloudflare Access intercept that app-path request at the edge.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { E2EContext } from "./global-setup";

function readCtx(): E2EContext {
	const file = path.resolve(process.cwd(), "e2e", ".e2e-ctx.json");
	if (!fs.existsSync(file)) {
		throw new Error(
			"e2e/.e2e-ctx.json not found — did globalSetup succeed?\n" +
				"Run with E2E_BASE_URL set to a dev deployment."
		);
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as E2EContext;
}

test.describe("Auth flow", () => {
	test("GET /auth/me returns the authenticated user and their workspaces", async ({ request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const res = await request.get("/auth/me", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		expect(res.ok()).toBe(true);

		const body = (await res.json()) as {
			user: { id: string; email: string };
			workspaces: Array<{ slug: string }>;
		};
		expect(body.user.id).toBeTruthy();
		expect(body.user.email).toBeTruthy();
		expect(body.workspaces.some((w) => w.slug === ctx.workspaceSlug)).toBe(true);
	});

	test("GET /auth/login redirects to the requested redirect_url", async ({ request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const res = await request.get("/auth/login?redirect_url=%2Fmy-issues", {
			maxRedirects: 0,
		});
		expect(res.status()).toBe(302);
		expect(res.headers().location ?? "").toBe("/my-issues");
	});
});
