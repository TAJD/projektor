/**
 * PROJ-222: E2E coverage for the Epics page.
 *
 * Tests:
 *  1. Navigate to /epics for the seeded project and confirm the page renders.
 *  2. Create a new epic via the "+ New Epic" modal.
 *  3. Assert it appears in the epics table.
 *  4. Filter by priority via the Filters popover and assert the epic disappears
 *     when the filter doesn't match, then reappears when cleared.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const EPIC_TITLE = "E2E Test Epic";

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

/** Navigate to /epics scoped to the seeded project, inject the workspace slug, and reload. */
async function openEpics(page: Page, ctx: E2EContext) {
	await page.goto(`/epics?projectId=${encodeURIComponent(ctx.grantedProjectId)}`);
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
		},
		{ slug: ctx.workspaceSlug }
	);
	await page.reload();
}

test.describe("Epics page", () => {
	test("creates an epic, sees it in the table, and filters it by priority", async ({ page }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		await openEpics(page, ctx);

		// Page heading always renders (before async data).
		await expect(page.locator("h1", { hasText: "Epics" })).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 1: Create a new epic
		// -----------------------------------------------------------------------
		const newEpicBtn = page.locator("button", { hasText: "+ New Epic" });
		await expect(newEpicBtn).toBeVisible({ timeout: 15_000 });
		await newEpicBtn.click();

		await expect(page.locator('[role="dialog"]', { hasText: "New Epic" })).toBeVisible({
			timeout: 5_000,
		});

		await page.locator("#create-epic-title").fill(EPIC_TITLE);
		await page.locator("button", { hasText: "Create Epic" }).click();

		// -----------------------------------------------------------------------
		// Step 2: Verify it appears in the epics table
		// -----------------------------------------------------------------------
		const epicRow = page.locator('table[aria-label="Epics"] a', { hasText: EPIC_TITLE });
		await expect(epicRow).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 3: Filter by a priority the new epic doesn't have — it should disappear
		// -----------------------------------------------------------------------
		await page.locator("button", { hasText: /^Filters/ }).click();
		await page.locator("button", { hasText: "urgent" }).click();

		await expect(
			page.locator("p", { hasText: "No epics match the active filters." })
		).toBeVisible({ timeout: 10_000 });
		await expect(epicRow).not.toBeVisible();

		// -----------------------------------------------------------------------
		// Step 4: Clear filters — the epic should reappear
		// -----------------------------------------------------------------------
		await page.locator("button", { hasText: "✕ Clear all" }).click();
		await expect(epicRow).toBeVisible({ timeout: 10_000 });
	});
});
