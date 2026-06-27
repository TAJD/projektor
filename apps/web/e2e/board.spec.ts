/**
 * PROJ-61: Playwright E2E for the kanban board.
 *
 * Test 1 (desktop): drag a card from the Todo column to In Progress.
 *   - Asserts the card appears in In Progress (optimistic update).
 *   - Asserts a PATCH request to /api/issues/:id was fired.
 *
 * Test 2 (mobile, 375×812): layout and drag-suppression.
 *   - Asserts .board-columns has flex-direction: column (columns stack vertically).
 *   - Asserts dragging a card does NOT fire a PATCH (guard: window.innerWidth < 640).
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

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
 * Navigate to /issues, inject workspace slug + board view into localStorage,
 * then reload so the Preact island picks them up.
 */
async function openBoard(page: Page, ctx: E2EContext) {
	await page.goto("/issues");
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
			localStorage.setItem("issues-view", "board");
		},
		{ slug: ctx.workspaceSlug },
	);
	await page.reload();

	// Wait for the board columns to render.  The island shows "Loading issues…"
	// while fetching, so we wait for the aria-labelled sections to appear.
	await page.waitForSelector('[aria-label="Todo column"]', { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Board – desktop drag", () => {
	test("drag card from Todo to In Progress triggers optimistic update and PATCH", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();

		await openBoard(page, ctx);

		// Confirm our seeded issue is in the Todo column.
		const todoColumn = page.locator('[aria-label="Todo column"]');
		await expect(todoColumn.locator("article")).toHaveCount(2, { timeout: 10_000 });

		// The card we want to drag shows the issue title.
		const dragCard = page.locator(
			'[aria-label="Todo column"] article',
			{ hasText: "E2E drag test issue" },
		);
		await expect(dragCard).toBeVisible();

		// Arm a listener for the PATCH before performing the drag.
		const patchPromise = page.waitForRequest(
			(req) =>
				req.method() === "PATCH" && req.url().includes(`/api/issues/${ctx.testIssueId}`),
			{ timeout: 10_000 },
		);

		// Perform HTML5 drag-and-drop.
		const inProgressColumn = page.locator('[aria-label="In Progress column"]');
		await dragCard.dragTo(inProgressColumn);

		// 1. A PATCH to /api/issues/:id must have been fired.
		const patchReq = await patchPromise;
		expect(patchReq.url()).toContain(`/api/issues/${ctx.testIssueId}`);
		const patchBody = patchReq.postDataJSON() as { statusId?: string };
		expect(patchBody.statusId).toBe(ctx.inProgressStatusId);

		// 2. The card must now appear in the In Progress column (optimistic update).
		await expect(
			page.locator('[aria-label="In Progress column"] article', {
				hasText: "E2E drag test issue",
			}),
		).toBeVisible({ timeout: 5_000 });

		// 3. The card must no longer appear in the Todo column.
		await expect(
			page.locator('[aria-label="Todo column"] article', {
				hasText: "E2E drag test issue",
			}),
		).not.toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Board – mobile layout + drag suppression", () => {
	test("columns stack vertically at 375 px", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();

		await openBoard(page, ctx);

		// Verify the guard condition holds: the browser's innerWidth is sub-640.
		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(innerWidth).toBeLessThan(640);

		// The .board-columns container must have flex-direction: column
		// (injected by the MOBILE_CSS @media block in IssueList.tsx).
		const flexDir = await page.evaluate(() => {
			const el = document.querySelector(".board-columns");
			if (!el) return null;
			return window.getComputedStyle(el).flexDirection;
		});
		expect(flexDir).toBe("column");
	});

	test("drag is suppressed (no PATCH) at 375 px", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();

		await openBoard(page, ctx);

		// Count PATCH requests during the drag attempt.
		const patches: string[] = [];
		await page.route("**/api/issues/**", async (route, request) => {
			if (request.method() === "PATCH") patches.push(request.url());
			await route.continue();
		});

		const todoColumn = page.locator('[aria-label="Todo column"]');
		const firstCard = todoColumn.locator("article").first();
		await expect(firstCard).toBeVisible({ timeout: 10_000 });

		const inProgressColumn = page.locator('[aria-label="In Progress column"]');
		// Attempt drag — onDragStart calls e.preventDefault() when innerWidth < 640.
		await firstCard.dragTo(inProgressColumn);

		// After the drag attempt, the Todo column should still have all its cards
		// (nothing moved) because the drop handler guards on window.innerWidth.
		await expect(todoColumn.locator("article")).toHaveCount(2, { timeout: 5_000 });

		// No PATCH should have been fired.
		expect(patches).toHaveLength(0);
	});
});
