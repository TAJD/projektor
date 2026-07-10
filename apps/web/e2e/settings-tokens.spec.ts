/**
 * PROJ-222: E2E coverage for the Settings → API Tokens page.
 *
 * Tests:
 *  1. Navigate to /settings/tokens and confirm the page renders.
 *  2. Create a new API token via the form.
 *  3. Assert the one-time token panel appears and the token is listed in the table.
 *  4. Revoke the token and confirm it's removed from the list.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
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

async function openTokens(page: Page, ctx: E2EContext) {
	await page.goto("/settings/tokens");
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
		},
		{ slug: ctx.workspaceSlug }
	);
	await page.reload();
}

test.describe("Settings → API Tokens page", () => {
	test("creates a token, sees the one-time reveal and table row, then revokes it", async ({
		page,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const tokenName = `E2E Test Token ${Date.now()}`;

		await openTokens(page, ctx);

		// Heading always renders (before async data).
		await expect(page.locator("h1", { hasText: "API Tokens" })).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 1: Open the create form and submit
		// -----------------------------------------------------------------------
		const newTokenBtn = page.locator("button", { hasText: "+ New token" });
		await expect(newTokenBtn).toBeVisible({ timeout: 15_000 });
		await newTokenBtn.click();

		await expect(page.locator("h3", { hasText: "New API token" })).toBeVisible({ timeout: 5_000 });
		await page.locator("#tok-name").fill(tokenName);
		await page.locator("button", { hasText: "Create token" }).click();

		// -----------------------------------------------------------------------
		// Step 2: One-time token reveal panel appears
		// -----------------------------------------------------------------------
		await expect(page.locator("p", { hasText: `Token created: ${tokenName}` })).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.locator("code")).toBeVisible();

		await page.locator("button", { hasText: "Done" }).click();

		// -----------------------------------------------------------------------
		// Step 3: Token appears in the table
		// -----------------------------------------------------------------------
		const tokenRow = page.locator("tr", { hasText: tokenName });
		await expect(tokenRow).toBeVisible({ timeout: 10_000 });

		// -----------------------------------------------------------------------
		// Step 4: Revoke the token
		// -----------------------------------------------------------------------
		await tokenRow.locator("button", { hasText: "Revoke" }).click();
		await tokenRow.locator("button", { hasText: "Yes" }).click();

		await expect(page.locator("tr", { hasText: tokenName })).toHaveCount(0, { timeout: 10_000 });
	});
});
