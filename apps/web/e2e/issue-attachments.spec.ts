/**
 * PROJ-405/406/407/408: Attachments panel on the issue detail page.
 *
 * Covers three attachment kinds surfaced in one unified "Attachments" panel:
 *  - PROJ-406: uploaded files (upload/download/delete/reject/isolation)
 *  - PROJ-407: wiki page references
 *  - PROJ-408: external URLs
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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

async function createIssue(request: APIRequestContext, ctx: E2EContext, title: string) {
	const res = await request.post("/api/issues", {
		headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		data: { projectId: ctx.grantedProjectId, title, priority: "medium" },
	});
	expect(res.status()).toBe(201);
	return (await res.json()) as { id: string };
}

async function openIssue(page: Page, ctx: E2EContext, issueId: string) {
	await page.goto(`/issues/view?id=${issueId}`);
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
		},
		{ slug: ctx.workspaceSlug },
	);
	await page.reload();
	await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
}

test.describe("Issue attachments panel", () => {
	test("file: upload, persist across reload, and delete", async ({ page, request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const issue = await createIssue(request, ctx, "E2E attachments — file happy path");
		await openIssue(page, ctx, issue.id);

		await page.locator("button", { hasText: "Attach file" }).click();
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "e2e-note.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("hello from e2e"),
		});
		await page.locator("button", { hasText: "Upload" }).click();

		const row = page.locator("a", { hasText: "e2e-note.txt" });
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(/^\d+(\.\d+)?\s?(B|KB|MB)$/)).toBeVisible();

		await page.reload();
		await expect(page.locator("a", { hasText: "e2e-note.txt" })).toBeVisible({ timeout: 10_000 });

		await page.locator(`[aria-label="Remove e2e-note.txt"]`).click();
		await expect(page.locator("a", { hasText: "e2e-note.txt" })).toHaveCount(0, { timeout: 10_000 });
	});

	test("file: disallowed type shows inline error and adds no entry", async ({ page, request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const issue = await createIssue(request, ctx, "E2E attachments — reject path");
		await openIssue(page, ctx, issue.id);

		await page.locator("button", { hasText: "Attach file" }).click();
		await page.locator('input[type="file"]').setInputFiles({
			name: "malware.exe",
			mimeType: "application/x-msdownload",
			buffer: Buffer.from("not really a virus"),
		});
		await page.locator("button", { hasText: "Upload" }).click();

		await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("a", { hasText: "malware.exe" })).toHaveCount(0);
	});

	test("file: attachments are scoped per-issue", async ({ page, request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const issueA = await createIssue(request, ctx, "E2E attachments — isolation A");
		const issueB = await createIssue(request, ctx, "E2E attachments — isolation B");

		await openIssue(page, ctx, issueA.id);
		await page.locator("button", { hasText: "Attach file" }).click();
		await page.locator('input[type="file"]').setInputFiles({
			name: "only-on-a.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("scoped to issue A"),
		});
		await page.locator("button", { hasText: "Upload" }).click();
		await expect(page.locator("a", { hasText: "only-on-a.txt" })).toBeVisible({ timeout: 10_000 });

		await openIssue(page, ctx, issueB.id);
		await expect(page.locator("a", { hasText: "only-on-a.txt" })).toHaveCount(0);
	});

	test("wiki page reference: attach, follow link, and remove", async ({ page, request }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const pageTitle = `E2E attachment target ${Date.now()}`;
		const wikiRes = await request.post("/api/wiki", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: { title: pageTitle, content: "linked from an issue" },
		});
		expect(wikiRes.status()).toBe(201);
		const wikiPage = (await wikiRes.json()) as { id: string; slug: string };

		const issue = await createIssue(request, ctx, "E2E attachments — wiki ref");
		await openIssue(page, ctx, issue.id);

		await page.locator("button", { hasText: "Link wiki page" }).click();
		await page.locator('input[placeholder="Search wiki pages…"]').fill(pageTitle);
		const resultBtn = page.locator("button", { hasText: pageTitle });
		await expect(resultBtn).toBeVisible({ timeout: 10_000 });
		await resultBtn.click();

		const link = page.locator("a", { hasText: pageTitle });
		await expect(link).toBeVisible({ timeout: 10_000 });
		await expect(link).toHaveAttribute("href", new RegExp(`slug=${wikiPage.slug}`));

		await link.click();
		await expect(page.locator("h1", { hasText: pageTitle })).toBeVisible({ timeout: 10_000 });
		await page.goBack();

		await expect(page.locator("a", { hasText: pageTitle })).toBeVisible({ timeout: 10_000 });
		await page.locator(`[aria-label="Remove ${pageTitle}"]`).click();
		await expect(page.locator("a", { hasText: pageTitle })).toHaveCount(0, { timeout: 10_000 });

		// The wiki page itself must survive removal of the reference.
		const checkRes = await request.get(`/api/wiki/${wikiPage.slug}`, {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		expect(checkRes.status()).toBe(200);
	});

	test("external URL: add with label, add without label, remove, and reject malformed input", async ({
		page,
		request,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const issue = await createIssue(request, ctx, "E2E attachments — url");
		await openIssue(page, ctx, issue.id);

		// Labeled URL
		await page.locator("button", { hasText: "Add URL" }).click();
		await page.locator('input[type="url"]').fill("https://example.com/design-doc");
		await page.locator('input[placeholder="Label (optional)"]').fill("Design doc");
		await page.locator("button", { hasText: /^Add$/ }).click();

		const labeledLink = page.locator("a", { hasText: "Design doc" });
		await expect(labeledLink).toBeVisible({ timeout: 10_000 });
		await expect(labeledLink).toHaveAttribute("target", "_blank");
		await expect(labeledLink).toHaveAttribute("href", "https://example.com/design-doc");

		// Unlabeled URL — shown as the raw URL text
		await page.locator("button", { hasText: "Add URL" }).click();
		await page.locator('input[type="url"]').fill("https://example.com/no-label");
		await page.locator("button", { hasText: /^Add$/ }).click();
		await expect(page.locator("a", { hasText: "https://example.com/no-label" })).toBeVisible({
			timeout: 10_000,
		});

		// Malformed URL rejected
		await page.locator("button", { hasText: "Add URL" }).click();
		await page.locator('input[type="url"]').fill("not-a-url");
		await page.locator("button", { hasText: /^Add$/ }).click();
		await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
		await page.locator("button", { hasText: "Cancel" }).click();

		// Remove the labeled entry
		await page.locator(`[aria-label="Remove Design doc"]`).click();
		await expect(page.locator("a", { hasText: "Design doc" })).toHaveCount(0, { timeout: 10_000 });
	});
});

test.describe("Issue attachments panel — mobile (375×812)", () => {
	test("attach controls stack full-width and stay within the viewport", async ({
		page,
		request,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();
		const issue = await createIssue(request, ctx, "E2E attachments — mobile layout");
		await openIssue(page, ctx, issue.id);

		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(innerWidth).toBeLessThan(640);

		const attachBtn = page.locator("button", { hasText: "Attach file" });
		await expect(attachBtn).toBeVisible();
		await attachBtn.click();

		const chooseFile = page.locator("label span", { hasText: "Choose file" });
		const chooseBox = await chooseFile.boundingBox();
		const viewportSize = page.viewportSize();
		if (!chooseBox || !viewportSize) throw new Error("boundingBox()/viewportSize() null");

		// Full-width control leaves only the page's horizontal padding on either side.
		expect(chooseBox.width).toBeGreaterThan(viewportSize.width * 0.7);
		expect(chooseBox.x + chooseBox.width).toBeLessThanOrEqual(viewportSize.width);

		// Touch targets meet the 44px minimum.
		expect(chooseBox.height).toBeGreaterThanOrEqual(44);

		const uploadBtn = page.locator("button", { hasText: "Upload" });
		const uploadBox = await uploadBtn.boundingBox();
		if (!uploadBox) throw new Error("boundingBox() returned null");
		expect(uploadBox.height).toBeGreaterThanOrEqual(44);
	});
});
