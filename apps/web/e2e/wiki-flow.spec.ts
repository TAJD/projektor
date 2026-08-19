/**
 * PROJ-163: Wiki create and edit E2E flow.
 *
 * Tests the full wiki lifecycle:
 *  1. Create a new page (title + markdown body).
 *  2. Assert it appears in the sidebar tree and renders its content.
 *  3. Edit the page body and save.
 *  4. Assert the updated content is displayed.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const INITIAL_CONTENT = "Hello from E2E wiki test";
const UPDATED_CONTENT = "Updated by E2E wiki test";

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

async function openWiki(page: Page, ctx: E2EContext) {
	await page.goto("/wiki");
	// Inject the test workspace slug so the island queries the right workspace.
	await page.evaluate(({ slug }: { slug: string }) => {
		localStorage.setItem("workspace-slug", slug);
	}, { slug: ctx.workspaceSlug });
	await page.reload();
}

/** Type into the CodeMirror editor. Clicks to focus, then types via keyboard. */
async function typeInEditor(page: Page, text: string) {
	const editor = page.locator(".cm-content").first();
	await editor.click();
	// Select all existing content and replace it.
	await page.keyboard.press("Control+a");
	await page.keyboard.type(text);
}

test.describe("Wiki create and edit flow", () => {
	test("creates a wiki page, reads it, edits it, and confirms the update", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openWiki(page, ctx);

		// Wait for the sidebar to render (the "+ New page" button is always present).
		const newPageBtn = page.locator("button", { hasText: "+ New page" });
		await expect(newPageBtn).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 1: Create the page
		// -----------------------------------------------------------------------
		await newPageBtn.click();

		// The create form should be visible in the main area.
		await expect(page.locator("h2", { hasText: "New page" })).toBeVisible({ timeout: 5_000 });

		// Fill in the title.
		const titleInput = page.locator("#create-title");
		await titleInput.fill("E2E Test Wiki Page");

		// Fill in content via the CodeMirror editor.
		await typeInEditor(page, INITIAL_CONTENT);

		// Submit.
		const createBtn = page.locator("button", { hasText: "Create page" });
		await createBtn.click();

		// -----------------------------------------------------------------------
		// Step 2: Verify the page appears in the sidebar tree
		// -----------------------------------------------------------------------
		// After creation the island navigates to the new page; the sidebar should
		// now show the title as an active entry.
		const treeEntry = page.locator("aside button", { hasText: "E2E Test Wiki Page" });
		await expect(treeEntry).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 3: Verify the page content is rendered
		// -----------------------------------------------------------------------
		await expect(page.locator("h1")).toContainText("E2E Test Wiki Page", { timeout: 10_000 });
		// Content is rendered inside .prose as HTML from markdown.
		await expect(page.locator(".prose")).toContainText(INITIAL_CONTENT, { timeout: 5_000 });

		// -----------------------------------------------------------------------
		// Step 4: Edit the page
		// -----------------------------------------------------------------------
		await page.locator("button", { hasText: "Edit" }).click();

		// The editor should appear (CodeMirror replaces the prose div).
		await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 5_000 });

		// Replace the body content.
		await typeInEditor(page, UPDATED_CONTENT);

		// Save.
		await page.locator("button", { hasText: "Save" }).click();

		// -----------------------------------------------------------------------
		// Step 5: Verify the updated content
		// -----------------------------------------------------------------------
		await expect(page.locator(".prose")).toContainText(UPDATED_CONTENT, { timeout: 10_000 });
		// Original content should be gone.
		await expect(page.locator(".prose")).not.toContainText(INITIAL_CONTENT, { timeout: 5_000 });
	});
});

// PROJ-423: wiki editor mobile layout regression coverage. MarkdownEditor was
// audited and found already responsive (toolbar wraps via flex-wrap, and a
// dedicated Edit/Preview toggle replaces the desktop side-by-side layout
// below 640px) — these tests lock that behaviour in.
test.describe("Wiki editor — mobile layout (375×812)", () => {
	test("editor fits the viewport and shows the mobile Edit/Preview toggle", async ({ page }) => {
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);

		const ctx = readCtx();
		await openWiki(page, ctx);

		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(innerWidth).toBeLessThan(640);

		const newPageBtn = page.locator("button", { hasText: "+ New page" });
		await expect(newPageBtn).toBeVisible({ timeout: 15_000 });
		await newPageBtn.click();

		await expect(page.locator("#create-title")).toBeVisible({ timeout: 5_000 });

		// The mobile Edit/Preview toggle only renders below 640px.
		const previewToggle = page.locator("button", { hasText: "Preview" });
		await expect(previewToggle).toBeVisible({ timeout: 5_000 });

		await typeInEditor(page, INITIAL_CONTENT);
		await previewToggle.click();
		await expect(page.locator(".prose")).toContainText(INITIAL_CONTENT, { timeout: 5_000 });

		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	});
});

// PROJ-664: wiki reader mobile layout regression coverage. Reproduced at 375px:
// (1) the page-tree sidebar went full-width and stacked 572px above the
// article, pushing the h1 below the fold; (2) the page action row
// ([+ Child page]/[Move]/[Edit]/[Delete], shrink-0, no scrolling ancestor)
// spilled the document 153px past the viewport; (3) the h1 was squeezed to
// one word per line by that same row. Fix: the sidebar became an off-canvas
// drawer behind a "Pages" trigger, and the action row collapsed to
// Edit + a "More page actions" overflow menu below 640px.
test.describe("Wiki reader — mobile layout (PROJ-664)", () => {
	test("article renders without horizontal scroll and the h1 is visible without scrolling, at 375×667 and 390×844", async ({
		page,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();

		for (const viewport of [
			{ width: 375, height: 667 },
			{ width: 390, height: 844 },
		]) {
			await page.setViewportSize(viewport);
			await openWiki(page, ctx);

			// Wiki index route (no page selected) — must not be a blank screen
			// behind a full-height sidebar.
			await expect(
				page.locator("text=/Select a page from the sidebar/i")
			).toBeInViewport({ timeout: 15_000 });

			let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(scrollWidth).toBeLessThanOrEqual(viewport.width);

			// Create a page with enough action buttons (owner-level permissions via
			// the dev-bypass user) to reproduce the action-row overflow if it regressed.
			// The page tree (and its "+ New page" button) lives in the off-canvas
			// drawer on mobile — open it via the "Pages" trigger first.
			await page.locator('button[aria-controls="wiki-page-tree"]', { hasText: "Pages" }).click();

			const newPageBtn = page.locator("button", { hasText: "+ New page" });
			await expect(newPageBtn).toBeVisible({ timeout: 15_000 });
			await newPageBtn.click();
			await page
				.locator("#create-title")
				.fill(
					`PROJ-664 ${viewport.width}x${viewport.height} ${ctx.workspaceSlug} ${test.info().project.name}`
				);
			await page.locator("button", { hasText: "Create page" }).click();

			const h1 = page.locator("h1");
			await expect(h1).toBeVisible({ timeout: 15_000 });
			await expect(h1).toBeInViewport();

			// Before the fix this was crushed to ~154px (one word per line).
			const h1Box = await h1.boundingBox();
			if (!h1Box) throw new Error("h1 boundingBox() null");
			expect(h1Box.width).toBeGreaterThan(200);

			scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
		}
	});

	test("page action row shows Edit + overflow menu on mobile, not the full desktop row", async ({
		page,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		await page.setViewportSize({ width: 375, height: 667 });
		const ctx = readCtx();
		await openWiki(page, ctx);

		await page.locator('button[aria-controls="wiki-page-tree"]', { hasText: "Pages" }).click();

		const newPageBtn = page.locator("button", { hasText: "+ New page" });
		await expect(newPageBtn).toBeVisible({ timeout: 15_000 });
		await newPageBtn.click();
		await page
			.locator("#create-title")
			.fill(`PROJ-664 action row ${ctx.workspaceSlug} ${test.info().project.name}`);
		await page.locator("button", { hasText: "Create page" }).click();
		await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

		await expect(page.locator("button", { hasText: "Edit" })).toBeVisible();
		await expect(page.locator("button", { hasText: "Move" })).toBeHidden();
		await expect(page.locator("button", { hasText: "Delete" })).toBeHidden();
		await expect(page.locator("button", { hasText: "+ Child page" })).toBeHidden();

		const overflowTrigger = page.locator('button[aria-label="More page actions"]');
		await expect(overflowTrigger).toBeVisible();
		await overflowTrigger.click();

		const menu = page.locator('[role="menu"][aria-label="More page actions"]');
		await expect(menu).toBeVisible();
		await expect(menu.locator('[role="menuitem"]', { hasText: "Move" })).toBeVisible();
		await expect(menu.locator('[role="menuitem"]', { hasText: "Delete" })).toBeVisible();
		await expect(menu.locator('[role="menuitem"]', { hasText: "+ Child page" })).toBeVisible();
	});

	test("'Pages' drawer opens, closes via scrim/Esc/navigation, and doesn't cover the article when closed", async ({
		page,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		await page.setViewportSize({ width: 375, height: 667 });
		const ctx = readCtx();
		await openWiki(page, ctx);

		await page.locator('button[aria-controls="wiki-page-tree"]', { hasText: "Pages" }).click();

		const newPageBtn = page.locator("button", { hasText: "+ New page" });
		await expect(newPageBtn).toBeVisible({ timeout: 15_000 });
		await newPageBtn.click();
		const pageTitle = `PROJ-664 drawer nav target ${ctx.workspaceSlug} ${test.info().project.name}`;
		await page.locator("#create-title").fill(pageTitle);
		await page.locator("button", { hasText: "Create page" }).click();
		await expect(page.locator("h1")).toContainText(pageTitle, {
			timeout: 15_000,
		});

		const trigger = page.locator('button[aria-controls="wiki-page-tree"]', { hasText: "Pages" });
		await expect(trigger).toBeVisible();
		const sidebar = page.locator("#wiki-page-tree");
		await expect(sidebar).not.toBeInViewport();

		// Open via the trigger, close via Esc.
		await trigger.click();
		await expect(sidebar).toBeInViewport();
		await page.keyboard.press("Escape");
		await expect(sidebar).not.toBeInViewport();

		// Open again, close via tapping the scrim.
		await trigger.click();
		await expect(sidebar).toBeInViewport();
		const viewport = page.viewportSize();
		if (!viewport) throw new Error("viewportSize() null");
		await page.mouse.click(viewport.width - 4, 100);
		await expect(sidebar).not.toBeInViewport();

		// Open again, close via navigating to a page in the tree.
		await trigger.click();
		await expect(sidebar).toBeInViewport();
		await sidebar.locator("button", { hasText: pageTitle }).first().click();
		await expect(sidebar).not.toBeInViewport();
	});
});
