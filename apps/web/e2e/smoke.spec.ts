/**
 * PROJ-106: Smoke test — verifies that auth headers injected via playwright.config.ts
 * are sufficient to bypass Cloudflare Access and reach the app.
 *
 * Skipped when E2E_BASE_URL or the required auth env vars are absent so CI stays
 * green for contributors who don't have CF credentials.
 */

import { expect, test } from "@playwright/test";

const hasAuth =
	!!process.env.E2E_BASE_URL &&
	!!process.env.CF_ACCESS_CLIENT_ID &&
	!!process.env.CF_ACCESS_CLIENT_SECRET &&
	!!process.env.PROJEKTOR_API_TOKEN;

test("home page is reachable and title contains Projektor", async ({ page }) => {
	test.skip(!hasAuth, "E2E_BASE_URL or CF auth env vars not set — skipping smoke test");

	await page.goto("/");
	await expect(page).toHaveTitle(/Projektor/i);
});
