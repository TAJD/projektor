/**
 * PROJ-222: E2E coverage for the public (unauthenticated) share view.
 *
 * Tests:
 *  1. Create an issue and a share link for it via the API.
 *  2. Navigate to /share/:token with no auth headers and confirm the issue
 *     title, priority, and project render.
 *  3. Navigate to /share/:token for a nonexistent token and confirm the
 *     "not found or expired" state renders.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const ISSUE_TITLE = "E2E share view test issue";

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

test.describe("Public share view", () => {
	test("renders a shared issue's title, priority, and project with no auth", async ({
		page,
		request,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();

		const createRes = await request.post("/api/issues", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: {
				projectId: ctx.grantedProjectId,
				title: ISSUE_TITLE,
				priority: "urgent",
			},
		});
		expect(createRes.status()).toBe(201);
		const issue = (await createRes.json()) as { id: string };

		const shareRes = await request.post(`/api/issues/${issue.id}/share`, {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		expect(shareRes.status()).toBe(201);
		const share = (await shareRes.json()) as { token: string };

		// Fresh, unauthenticated context — no CF Access / bearer headers from
		// playwright.config.ts should be required for this public route.
		const publicContext = await page.context().browser()?.newContext();
		const publicPage = await publicContext?.newPage();
		if (!publicPage) throw new Error("failed to create an unauthenticated browser context");

		try {
			await publicPage.goto(`/share/${share.token}`);
			await expect(publicPage.locator("h1", { hasText: ISSUE_TITLE })).toBeVisible({
				timeout: 15_000,
			});
			await expect(publicPage.getByText("Urgent")).toBeVisible();
			await expect(publicPage.getByText(new RegExp(ctx.grantedProjectKey))).toBeVisible();
		} finally {
			await publicContext?.close();
		}
	});

	test("shows the expired/not-found state for a nonexistent share token", async ({ page }) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		await page.goto("/share/this-token-does-not-exist");
		await expect(page.locator("h2", { hasText: "Link not found or expired" })).toBeVisible({
			timeout: 15_000,
		});
	});
});
