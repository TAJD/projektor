/**
 * PROJ-397: Mobile issue-list layout regression tests.
 *
 * Covers two bugs found in a reported screenshot at 375×812 (see PROJ-397):
 * 1. The issue count label ("N issues (of M)") could wrap to multiple lines
 *    and visually overlap the "+ New issue" button / list-board-backlog
 *    toggle, since the header row never dropped to a second line on mobile.
 * 2. The filter dropdowns in the toolbar wrapped into a ragged, uneven grid
 *    instead of stacking full-width.
 *
 * Also covers the mobile navigation drawer (hamburger menu), which has no
 * existing coverage.
 *
 * Run with: pnpm --filter @projektor/web exec playwright test --project=mobile mobile-issue-list
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
				"Run with E2E_BASE_URL set to a dev deployment.",
		);
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as E2EContext;
}

async function openIssues(page: Page, ctx: E2EContext) {
	await page.goto("/issues");
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
		},
		{ slug: ctx.workspaceSlug },
	);
	await page.reload();
	await page.waitForSelector("text=/\\d+ issues?/", { timeout: 15_000 });
}

async function openCreateModal(page: Page, ctx: E2EContext) {
	await openIssues(page, ctx);
	await page.locator("button", { hasText: "+ New issue" }).click();
	const dialog = page.locator('[role="dialog"][aria-label="Create new issue"]');
	await expect(dialog).toBeVisible({ timeout: 5_000 });
	return dialog;
}

test.describe("Mobile issue list layout (375×812)", () => {
	test("header row: New issue button and view toggle never overlap the count label", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openIssues(page, ctx);

		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(innerWidth).toBeLessThan(640);

		const countLabel = page.locator("p", { hasText: /issues?/ }).first();
		const newIssueBtn = page.locator("button", { hasText: "+ New issue" });
		await expect(countLabel).toBeVisible();
		await expect(newIssueBtn).toBeVisible();

		const labelBox = await countLabel.boundingBox();
		const btnBox = await newIssueBtn.boundingBox();
		if (!labelBox || !btnBox) throw new Error("boundingBox() returned null");

		// The two elements must not intersect vertically at all — on mobile the
		// button row must sit entirely below the (possibly multi-line) count
		// label, not overlap it.
		const labelBottom = labelBox.y + labelBox.height;
		expect(btnBox.y).toBeGreaterThanOrEqual(labelBottom);
	});

	test("filter dropdowns stack full-width instead of wrapping raggedly", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openIssues(page, ctx);

		const projectSelect = page.locator('[aria-label="Filter by project"]');
		await expect(projectSelect).toBeVisible();

		const selectBox = await projectSelect.boundingBox();
		const viewportSize = page.viewportSize();
		if (!selectBox || !viewportSize) throw new Error("boundingBox()/viewportSize() null");

		// Full-width dropdowns leave only the page's horizontal padding on
		// either side — assert the select spans the large majority of the
		// viewport rather than shrink-wrapping to its label text.
		expect(selectBox.width).toBeGreaterThan(viewportSize.width * 0.7);
	});

	test("hamburger opens the navigation drawer, and tapping a link closes it", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		await page.goto("/");

		const hamburger = page.locator('[aria-label="Open navigation menu"]');
		await expect(hamburger).toBeVisible();

		const sidebar = page.locator("#app-sidebar");
		await expect(sidebar).not.toBeInViewport();

		await hamburger.click();
		await expect(sidebar).toBeInViewport();
		await expect(page.locator('[aria-label="Close navigation menu"]')).toBeVisible();

		await sidebar.locator("a", { hasText: "My Issues" }).click();
		await expect(page).toHaveURL(/\/my-issues/);
		await expect(sidebar).not.toBeInViewport();
	});

	test("New issue modal opens and creates an issue from the mobile toolbar", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openIssues(page, ctx);

		const newIssueBtn = page.locator("button", { hasText: "+ New issue" });
		await expect(newIssueBtn).toBeVisible();
		await newIssueBtn.click();

		const dialog = page.locator('[role="dialog"][aria-label="Create new issue"]');
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		// The modal must fit within the mobile viewport, not overflow it.
		const dialogBox = await dialog.boundingBox();
		const viewportSize = page.viewportSize();
		if (!dialogBox || !viewportSize) throw new Error("boundingBox()/viewportSize() null");
		expect(dialogBox.width).toBeLessThanOrEqual(viewportSize.width);

		// CD-294: the action row must be reachable without the user having to
		// fight the page behind the sheet. Before the fix it sat below the fold.
		await expect(dialog.locator('button[type="submit"]')).toBeInViewport();
		await expect(dialog.locator("button", { hasText: "Cancel" })).toBeInViewport();

		await dialog.locator('input[placeholder="Issue title"]').fill("E2E Mobile Test Issue");
		await dialog.locator('button[type="submit"]', { hasText: "Create issue" }).click();

		await expect(dialog).not.toBeVisible({ timeout: 10_000 });
		await expect(
			page.locator("a", { hasText: "E2E Mobile Test Issue" }).first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("New issue modal renders above the topbar, not under it (CD-294)", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const dialog = await openCreateModal(page, readCtx());
		await expect(dialog).toBeVisible();

		// The topbar is z-index: 110 (Base.astro); the backdrop used to be z-50, so
		// the topbar painted over the sheet and stayed tappable behind it.
		const stacking = await page.evaluate(() => {
			const topbar = document.querySelector(".app-topbar");
			const backdrop = document
				.querySelector('[role="dialog"][aria-label="Create new issue"]')
				?.closest("div.fixed");
			if (!topbar || !backdrop) return null;
			return {
				topbar: Number(getComputedStyle(topbar).zIndex),
				backdrop: Number(getComputedStyle(backdrop).zIndex),
			};
		});
		if (!stacking) throw new Error("topbar/backdrop not found");
		expect(stacking.backdrop).toBeGreaterThan(stacking.topbar);

		// And the point at the topbar's centre must belong to the modal, not the topbar.
		const box = await page.locator(".app-topbar").boundingBox();
		if (!box) throw new Error("topbar boundingBox() null");
		const hitsModal = await page.evaluate(
			({ x, y }) =>
				!!document.elementFromPoint(x, y)?.closest('[aria-label="Create new issue"], div.fixed'),
			{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
		);
		expect(hitsModal).toBe(true);
	});

	test("dropdowns inside the New issue modal stay open and on-screen while scrolling (CD-294)", async ({
		page,
	}) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const dialog = await openCreateModal(page, readCtx());

		const trigger = dialog.locator('[aria-label="Select priority"]');
		await trigger.scrollIntoViewIfNeeded();
		await trigger.click();

		const listbox = page.locator('[role="listbox"][aria-label="Select priority"]');
		await expect(listbox).toBeVisible();
		await expect(listbox).toBeInViewport();
		// Every option must be reachable — the old fixed menu could hang off the
		// bottom of the viewport with no way to scroll it into view.
		const options = listbox.locator('[role="option"]');
		for (let i = 0; i < (await options.count()); i++) {
			await expect(options.nth(i)).toBeInViewport();
		}

		// Scrolling the modal body used to fire resize/scroll and kill the menu.
		await dialog
			.locator("form > div")
			.first()
			.evaluate((el) => el.scrollBy(0, 40));
		await expect(listbox).toBeVisible();
		await expect(listbox).toBeInViewport();

		await options.first().click();
		await expect(listbox).toBeHidden();
	});
});
