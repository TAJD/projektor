/**
 * PROJ-164: Sprint planning E2E flow.
 *
 * Tests the full sprint lifecycle:
 *  1. Navigate to /sprints and create a new sprint.
 *  2. Assert the sprint appears in the sprint list.
 *  3. Follow "View issues →" to /issues filtered by that sprint.
 *  4. Assert the sprint banner shows the sprint name.
 *  5. Activate the sprint via the banner's inline Edit form.
 *  6. Return to /sprints and complete the sprint.
 *  7. Assert the completion summary panel appears.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const SPRINT_NAME = "E2E Test Sprint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Fetch the first project's ID from the test workspace.
 * globalSetup seeds an "E2E" project, so this always returns something.
 */
async function fetchFirstProjectId(base: string, workspaceSlug: string): Promise<string> {
	const res = await fetch(`${base}/api/projects`, {
		headers: { "X-Workspace-Slug": workspaceSlug },
	});
	if (!res.ok) throw new Error(`GET /api/projects → ${res.status}`);
	const data = (await res.json()) as { items: Array<{ id: string }> };
	if (!data.items?.length) throw new Error("No projects found in the test workspace");
	return data.items[0].id;
}

/**
 * Navigate to /sprints for a given project, inject the test workspace slug,
 * and reload so the SprintManager island picks everything up.
 */
async function openSprints(page: Page, ctx: E2EContext, projectId: string) {
	await page.goto(`/sprints?projectId=${encodeURIComponent(projectId)}`);
	await page.evaluate(({ slug }: { slug: string }) => {
		localStorage.setItem("workspace-slug", slug);
	}, { slug: ctx.workspaceSlug });
	await page.reload();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Sprint planning flow", () => {
	test("creates a sprint, verifies it, filters issues by sprint, verifies the banner, and completes the sprint", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		const base = process.env.E2E_BASE_URL as string;
		const projectId = await fetchFirstProjectId(base, ctx.workspaceSlug);

		// -----------------------------------------------------------------------
		// Step 1: Navigate to /sprints
		// -----------------------------------------------------------------------
		await openSprints(page, ctx, projectId);

		// SprintManager renders an h1 immediately (before any async data).
		await expect(page.locator("h1", { hasText: "Sprints" })).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 2: Create a new sprint
		// -----------------------------------------------------------------------
		const newSprintBtn = page.locator("button", { hasText: "+ New sprint" });
		await expect(newSprintBtn).toBeVisible({ timeout: 10_000 });
		await newSprintBtn.click();

		// The create form should be visible.
		await expect(page.locator("h3", { hasText: "New sprint" })).toBeVisible({ timeout: 5_000 });

		// Fill in the required name field.
		await page.locator("#spr-name").fill(SPRINT_NAME);

		// Submit.
		await page.locator('button[type="submit"]', { hasText: "Create sprint" }).click();

		// -----------------------------------------------------------------------
		// Step 3: Verify the sprint appears in the list
		// -----------------------------------------------------------------------
		// The create form disappears on success and the list re-renders.
		await expect(page.locator("h3", { hasText: "New sprint" })).not.toBeVisible({
			timeout: 10_000,
		});
		// Sprint cards render the name in a font-semibold span.
		await expect(
			page.locator("span.font-semibold", { hasText: SPRINT_NAME }),
		).toBeVisible({ timeout: 10_000 });

		// -----------------------------------------------------------------------
		// Step 4: Navigate to /issues filtered by this sprint
		// -----------------------------------------------------------------------
		// Each sprint card renders a "View issues →" link with ?sprintId= in the href.
		const viewIssuesLink = page.locator("a", { hasText: "View issues →" }).first();
		await expect(viewIssuesLink).toBeVisible({ timeout: 5_000 });

		// Capture the href so we can verify the URL after navigation.
		const href = await viewIssuesLink.getAttribute("href");
		expect(href).toContain("sprintId=");

		await viewIssuesLink.click();

		// Browser should now be on /issues?sprintId=…
		await expect(page).toHaveURL(/sprintId=/, { timeout: 10_000 });

		// -----------------------------------------------------------------------
		// Step 5: Verify the sprint banner appears with the sprint name
		// -----------------------------------------------------------------------
		// IssueList reads sprintId from URL params on mount, fetches the sprint
		// detail, then renders the banner.  Wait generously for the async fetch.
		await expect(
			page.locator("span.font-semibold", { hasText: SPRINT_NAME }),
		).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 6: Activate the sprint via the banner's inline Edit form
		//
		// "Complete sprint" in SprintManager only appears for status==="active"
		// sprints.  The banner's Edit form lets us change the status in-place.
		// -----------------------------------------------------------------------
		await page.locator("button", { hasText: "Edit" }).click();

		// The native <select> for sprint status is inside the Edit form.
		const statusSelect = page.locator("select");
		await expect(statusSelect).toBeVisible({ timeout: 5_000 });
		await statusSelect.selectOption("active");

		// Save.
		await page.locator('button[type="submit"]', { hasText: "Save" }).click();

		// After saving, the banner (non-edit) view re-renders with the new status.
		// The status badge shows "active" (capitalized in the UI).
		await expect(page.locator("span", { hasText: "active" })).toBeVisible({ timeout: 10_000 });

		// -----------------------------------------------------------------------
		// Step 7: Return to /sprints and complete the sprint
		// -----------------------------------------------------------------------
		await openSprints(page, ctx, projectId);
		await expect(page.locator("h1", { hasText: "Sprints" })).toBeVisible({ timeout: 15_000 });

		// The sprint is now active → "Complete sprint" button should appear.
		const completeBtn = page.locator("button", { hasText: "Complete sprint" });
		await expect(completeBtn).toBeVisible({ timeout: 10_000 });
		await completeBtn.click();

		// A confirmation row appears: "Mark complete?" + "Yes, complete" + "Cancel".
		const confirmBtn = page.locator("button", { hasText: "Yes, complete" });
		await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
		await confirmBtn.click();

		// -----------------------------------------------------------------------
		// Step 8: Verify the completion summary panel
		// -----------------------------------------------------------------------
		// CompletionSummaryPanel renders: "Sprint complete: <name>"
		await expect(
			page.locator("h3", { hasText: `Sprint complete: ${SPRINT_NAME}` }),
		).toBeVisible({ timeout: 10_000 });
	});
});

// PROJ-421: sprint list mobile layout regression coverage. SprintManager was
// audited and found already responsive (flex-wrap throughout, no fixed
// widths) — these tests lock that behaviour in rather than leaving it
// unverified.
test.describe("Sprint list — mobile layout (375×812)", () => {
	test("header row and sprint cards fit the viewport with no horizontal scroll", async ({
		page,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const base = process.env.E2E_BASE_URL as string;
		const projectId = await fetchFirstProjectId(base, ctx.workspaceSlug);
		await openSprints(page, ctx, projectId);

		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(innerWidth).toBeLessThan(640);

		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

		const countLabel = page.locator("p", { hasText: /sprints?/i }).first();
		const newSprintBtn = page.locator("button", { hasText: "+ New sprint" });
		await expect(countLabel).toBeVisible();
		await expect(newSprintBtn).toBeVisible();

		const labelBox = await countLabel.boundingBox();
		const btnBox = await newSprintBtn.boundingBox();
		if (!labelBox || !btnBox) throw new Error("boundingBox() returned null");
		expect(btnBox.y).toBeGreaterThanOrEqual(labelBox.y + labelBox.height);
	});
});
