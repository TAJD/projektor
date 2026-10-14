/**
 * PROJ-1036/1037: link preview cards and paste-a-URL in a real browser.
 *
 * - A bare issue link on its own line renders as a card with the issue's ref and title.
 * - A wiki link with a #fragment names the section on its card.
 * - Pasting a URL into the comment editor offers Card | Link; Link writes `[title](url)`.
 *
 * Only internal links are used, so nothing here depends on a third-party site.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { E2EContext } from "./global-setup";

function readCtx(): E2EContext {
	const file = path.resolve(process.cwd(), "e2e", ".e2e-ctx.json");
	if (!fs.existsSync(file)) {
		throw new Error("e2e/.e2e-ctx.json not found — did globalSetup succeed?");
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as E2EContext;
}

async function createIssue(
	request: APIRequestContext,
	ctx: E2EContext,
	title: string,
	body = ""
): Promise<{ id: string; number: number }> {
	const res = await request.post("/api/issues", {
		headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		data: { projectId: ctx.grantedProjectId, title, body },
	});
	expect(res.status()).toBe(201);
	return (await res.json()) as { id: string; number: number };
}

async function openIssue(page: Page, ctx: E2EContext, issueId: string) {
	// The config's extraHTTPHeaders default the workspace to PUBLIC_WORKSPACE_SLUG; the
	// data here lives in the per-run e2e workspace, so the page must ask for that one.
	await page.setExtraHTTPHeaders({ "X-Workspace-Slug": ctx.workspaceSlug });
	await page.goto(`/issues/view?id=${issueId}`);
	await page.evaluate(
		({ slug }: { slug: string }) => localStorage.setItem("workspace-slug", slug),
		{ slug: ctx.workspaceSlug }
	);
	await page.reload();
	await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
}

function issueUrl(ctx: E2EContext, number: number): string {
	return `${process.env.E2E_BASE_URL?.replace(/\/$/, "")}/projects/${ctx.grantedProjectKey}/issues/${number}/target`;
}

test.describe("Link preview cards", () => {
	test.beforeEach(() => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");
	});

	test("a bare issue link renders as a card with its ref and title", async ({ page, request }) => {
		const ctx = readCtx();
		const target = await createIssue(request, ctx, `E2E card target ${Date.now()}`);
		const source = await createIssue(
			request,
			ctx,
			"E2E card source",
			`See below.\n\n${issueUrl(ctx, target.number)}\n\nThe end.`
		);
		await openIssue(page, ctx, source.id);

		const card = page.locator(".link-card__link--issue").first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".link-card__ref")).toHaveText(
			`${ctx.grantedProjectKey}-${target.number}`
		);
		await expect(card.locator(".link-card__title")).toContainText("E2E card target");
	});

	test("a wiki link with a #fragment names the section", async ({ page, request }) => {
		const ctx = readCtx();
		const wikiRes = await request.post("/api/wiki", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: {
				title: `E2E card wiki ${Date.now()}`,
				content: "# Overview\n\n## Install steps\n\nRun the installer.",
			},
		});
		expect(wikiRes.status()).toBe(201);
		const wiki = (await wikiRes.json()) as { slug: string };
		const base = process.env.E2E_BASE_URL?.replace(/\/$/, "");
		const source = await createIssue(
			request,
			ctx,
			"E2E wiki card source",
			`${base}/wiki/${wiki.slug}#install-steps`
		);
		await openIssue(page, ctx, source.id);

		const card = page.locator(".link-card__link--wiki").first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".link-card__section")).toHaveText("§ Install steps");
	});

	test("pasting a URL into a comment offers Card | Link; Link writes a markdown link", async ({
		page,
		request,
	}) => {
		const ctx = readCtx();
		const title = `E2E paste target ${Date.now()}`;
		const target = await createIssue(request, ctx, title);
		const source = await createIssue(request, ctx, "E2E paste source");
		await openIssue(page, ctx, source.id);

		const editor = page.locator('.cm-content[aria-label="Add a comment"]');
		await expect(editor).toBeVisible({ timeout: 20_000 });
		await editor.click();
		const url = issueUrl(ctx, target.number);
		await editor.evaluate((node, text) => {
			const data = new DataTransfer();
			data.setData("text/plain", text);
			node.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, url);

		const popover = page.getByRole("toolbar", { name: "Pasted link" });
		await expect(popover).toBeVisible();
		await expect(editor).toHaveText(url);

		await popover.getByRole("button", { name: "Link" }).click();
		await expect(editor).toContainText(`[${title}](${url})`, { timeout: 10_000 });
		await expect(popover).toBeHidden();

		await page.getByRole("button", { name: "Comment", exact: true }).click();
		const posted = page.locator(".prose a", { hasText: title });
		await expect(posted).toBeVisible({ timeout: 10_000 });
		// An inline link, not a card.
		await expect(page.locator(".link-card__link", { hasText: title })).toHaveCount(0);
	});
});
