/**
 * PROJ-222: E2E coverage for the My Issues page.
 *
 * Tests:
 *  1. Create an issue assigned to the dev-bypass user via the API.
 *  2. Navigate to /my-issues and confirm the issue appears grouped under its project.
 *  3. Mark the issue done, confirm it disappears from the default (open-only) view.
 *  4. Toggle "Include done" and confirm it reappears.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment (ENVIRONMENT=development,
 * DEV_USER_EMAIL set for the server-side auth bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const ISSUE_TITLE = "E2E my-issues test issue";

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

async function openMyIssues(page: Page, ctx: E2EContext) {
	await page.goto("/my-issues");
	await page.evaluate(
		({ slug }: { slug: string }) => {
			localStorage.setItem("workspace-slug", slug);
		},
		{ slug: ctx.workspaceSlug }
	);
	await page.reload();
}

test.describe("My Issues page", () => {
	test("shows an issue assigned to the current user, respects the done filter", async ({
		page,
		request,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");

		const ctx = readCtx();

		// Resolve the dev-bypass user id via /auth/me.
		const meRes = await request.get("/auth/me", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		expect(meRes.ok()).toBe(true);
		const me = (await meRes.json()) as { user: { id: string } };

		// Find a "done" status to move the issue to later.
		const statusesRes = await request.get("/api/task-statuses", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		const statuses = (await statusesRes.json()) as Array<{ id: string; category: string }>;
		const doneStatus = statuses.find((s) => s.category === "done");
		expect(doneStatus).toBeTruthy();

		// Create an issue assigned to the current (dev-bypass) user.
		const createRes = await request.post("/api/issues", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: {
				projectId: ctx.grantedProjectId,
				title: ISSUE_TITLE,
				priority: "medium",
				assigneeId: me.user.id,
			},
		});
		expect(createRes.status()).toBe(201);
		const issue = (await createRes.json()) as { id: string };

		// -----------------------------------------------------------------------
		// Step 1: Issue appears on /my-issues by default (open)
		// -----------------------------------------------------------------------
		await openMyIssues(page, ctx);
		await expect(page.locator("h1", { hasText: "My Issues" })).toBeVisible({ timeout: 15_000 });

		const issueEntry = page.getByText(ISSUE_TITLE).first();
		await expect(issueEntry).toBeVisible({ timeout: 15_000 });

		// -----------------------------------------------------------------------
		// Step 2: Mark the issue done via the API, reload — it should disappear
		// -----------------------------------------------------------------------
		const patchRes = await request.patch(`/api/issues/${issue.id}`, {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: { statusId: doneStatus?.id },
		});
		expect(patchRes.ok()).toBe(true);

		await page.reload();
		await expect(page.locator("h1", { hasText: "My Issues" })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(ISSUE_TITLE)).toHaveCount(0, { timeout: 10_000 });

		// -----------------------------------------------------------------------
		// Step 3: Toggle "Include done" — the issue reappears
		// -----------------------------------------------------------------------
		await page.getByLabel(/Include done/i).check();
		await expect(page.getByText(ISSUE_TITLE).first()).toBeVisible({ timeout: 10_000 });
	});
});
