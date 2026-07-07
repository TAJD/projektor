/**
 * PROJ-310: deterministic long-running freeze regression test.
 *
 * PROJ-305 fixed two compounding bugs in MarkdownEditor's CodeMirror<->Preact
 * sync: a reentrant onChange->setState->value-prop echo that could clobber
 * in-flight keystrokes, and a real-browser layout thrash from nested
 * overflow-auto containers. Neither reproduces in jsdom (no layout engine,
 * no real event timing), so this test drives sustained, bursty typing -
 * interleaved with idle pauses long enough to trigger the wiki
 * draft-autosave debounce (PROJ-227, 1000ms) and cursor movement between
 * bursts - against a real browser, and asserts bounded-time responsiveness
 * at every step rather than relying on the overall test timeout to catch a
 * hang.
 *
 * Tagged `@long` in the test titles: excluded from `pnpm test:e2e`, run via
 * `pnpm test:e2e:long`. Desktop project only (see test.skip below) - this is
 * about typing/layout timing, not mobile-specific behavior.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const BURSTS = 150;
const STEP_TIMEOUT = 2_000;
// Exceeds the wiki draft-autosave debounce (1000ms, PROJ-227) so its
// localStorage-write re-render lands mid-run, same timing as when PROJ-305
// was reproducing.
const IDLE_MS = 1_000;

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

async function setWorkspaceSlug(page: Page, slug: string) {
	await page.evaluate(({ slug: s }: { slug: string }) => {
		localStorage.setItem("workspace-slug", s);
	}, { slug });
}

/**
 * Types BURSTS chunks into the editor at `editorSelector`, asserting the
 * editor reflects each burst within STEP_TIMEOUT (a hang on any single
 * burst — not just the run as a whole — is what "freezing" looks like),
 * moving the cursor and idling past the autosave debounce between bursts.
 * Returns the full expected content for a final exact-match check.
 */
async function sustainedTypingRun(page: Page, editorSelector: string): Promise<string> {
	const editor = page.locator(editorSelector).first();
	await editor.click();
	await page.keyboard.press("Control+a");
	await page.keyboard.press("Delete");

	let expected = "";
	for (let i = 0; i < BURSTS; i++) {
		const chunk = `b${i}-word `;
		await page.keyboard.type(chunk, { delay: 10 });
		expected += chunk;

		await expect(editor).toContainText(chunk.trim(), { timeout: STEP_TIMEOUT });

		// Cursor movement between bursts, exercising the same doc-position math
		// the reentrant echo (PROJ-305) could desync.
		await page.keyboard.press("Home");
		await page.keyboard.press("End");

		await page.waitForTimeout(IDLE_MS);
	}

	const finalText = (await editor.textContent())?.trim() ?? "";
	expect(finalText).toBe(expected.trim());
	return expected;
}

/** Selects everything and clicks the Bold toolbar button; asserts the wrap applied. */
async function assertBoldWrapWorks(page: Page) {
	await page.keyboard.press("Control+a");
	await page.getByTitle("Bold (Ctrl+B)").click();
	const content = ((await page.locator(".cm-content").first().textContent()) ?? "").trim();
	expect(content.startsWith("**")).toBe(true);
	expect(content.endsWith("**")).toBe(true);
}

test.describe("Editor freeze regression (long-running)", () => {
	test.beforeEach(async ({}, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"Long-running freeze test runs on desktop only",
		);
		test.skip(
			!process.env.E2E_BASE_URL,
			"E2E_BASE_URL not set — skipping live deployment test",
		);
	});

	test("wiki page editor survives sustained typing without freezing @long", async ({ page }) => {
		test.setTimeout(10 * 60 * 1000);
		const ctx = readCtx();

		await page.goto("/wiki");
		await setWorkspaceSlug(page, ctx.workspaceSlug);
		await page.reload();

		const newPageBtn = page.locator("button", { hasText: "+ New page" });
		await expect(newPageBtn).toBeVisible({ timeout: 15_000 });
		await newPageBtn.click();

		await expect(page.locator("h2", { hasText: "New page" })).toBeVisible({ timeout: 5_000 });
		await page.locator("#create-title").fill("E2E Freeze Test Wiki Page");
		await page.locator(".cm-content").first().click();
		await page.keyboard.type("seed");
		await page.locator("button", { hasText: "Create page" }).click();

		await expect(page.locator("h1")).toContainText("E2E Freeze Test Wiki Page", {
			timeout: 15_000,
		});

		await page.locator("button", { hasText: "Edit" }).click();
		await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 5_000 });

		await sustainedTypingRun(page, ".cm-content");
		await assertBoldWrapWorks(page);

		await page.locator("button", { hasText: "Save" }).click();
		await expect(page.locator(".prose")).toContainText("b0-word", { timeout: 10_000 });
	});

	test("issue description editor survives sustained typing without freezing @long", async ({
		page,
	}) => {
		test.setTimeout(10 * 60 * 1000);
		const ctx = readCtx();

		await page.goto(`/issues/view?id=${ctx.testIssueId}`);
		await setWorkspaceSlug(page, ctx.workspaceSlug);
		await page.reload();

		await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

		await page.getByTitle("Edit description").click();
		await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 5_000 });

		await sustainedTypingRun(page, ".cm-content");
		await assertBoldWrapWorks(page);

		await page.locator("button", { hasText: "Save" }).click();
		await expect(page.locator(".prose")).toContainText("b0-word", { timeout: 10_000 });
	});
});
