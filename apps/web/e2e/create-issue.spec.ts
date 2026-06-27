/**
 * PROJ-162: Create issue E2E flow.
 *
 * Tests the "New issue" modal: fill in title + priority, submit, assert the
 * issue appears in the list view, navigate to the detail page, and verify the
 * title and a status badge are visible.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass, workspace must have at
 * least one project — the "E2E" project created by globalSetup satisfies this).
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
				"Run with E2E_BASE_URL set to a dev deployment.",
		);
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as E2EContext;
}

async function openIssues(page: Page, ctx: E2EContext) {
	await page.goto("/issues");
	// Inject the test workspace slug so the island queries the right workspace.
	await page.evaluate(({ slug }: { slug: string }) => {
		localStorage.setItem("workspace-slug", slug);
	}, { slug: ctx.workspaceSlug });
	await page.reload();
}

test.describe("Create issue flow", () => {
	test("creates a new issue and views it on the detail page", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openIssues(page, ctx);

		// Wait for the island to load and for at least one project to be fetched
		// (the "New issue" button is gated on projects.length > 0).
		const newIssueBtn = page.locator("button", { hasText: "+ New issue" });
		await expect(newIssueBtn).toBeVisible({ timeout: 20_000 });
		await newIssueBtn.click();

		// Wait for the create-issue modal.
		const dialog = page.locator('[role="dialog"][aria-label="Create new issue"]');
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		// Fill in the title.
		const titleInput = dialog.locator('input[placeholder="Issue title"]');
		await titleInput.fill("E2E Test Issue");

		// Change priority to "high" via the custom Select combobox.
		const priorityTrigger = dialog.locator('[aria-label="Select priority"]');
		await priorityTrigger.click();
		await page.locator('[role="option"]', { hasText: "High" }).click();

		// Submit the form.
		await dialog.locator('button[type="submit"]', { hasText: "Create issue" }).click();

		// Modal should close and the new issue should appear in the list.
		await expect(dialog).not.toBeVisible({ timeout: 10_000 });
		const issueLink = page.locator("a", { hasText: "E2E Test Issue" }).first();
		await expect(issueLink).toBeVisible({ timeout: 10_000 });

		// Navigate to the detail page.
		await issueLink.click();
		await expect(page.locator("h1")).toContainText("E2E Test Issue", { timeout: 10_000 });

		// A status badge must be visible somewhere on the detail page.
		// IssueDetail renders statuses in a Select with an aria-label.
		await expect(
			page.locator('[aria-label^="Change status"]'),
		).toBeVisible({ timeout: 5_000 });
	});
});
