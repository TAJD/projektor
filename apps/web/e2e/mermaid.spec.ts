/**
 * PROJ-883: mermaid diagrams render as real SVG (not mocked) on the public share view,
 * in light and dark themes, and a broken diagram keeps its source with a failure note.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 * Target: E2E_BASE_URL pointing at a dev deployment.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { E2EContext } from "./global-setup";

const GOOD = "```mermaid\ngraph TD\n    A[Start] --> B[End]\n```";
const BROKEN = "```mermaid\ngraph TD\n    A --> --> B\n```";

function readCtx(): E2EContext {
	const file = path.resolve(process.cwd(), "e2e", ".e2e-ctx.json");
	if (!fs.existsSync(file)) {
		throw new Error("e2e/.e2e-ctx.json not found — did globalSetup succeed?");
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as E2EContext;
}

test.describe("Mermaid rendering", () => {
	test("renders an SVG in light and dark and re-draws on theme toggle; broken source shows a note", async ({
		page,
		request,
	}) => {
		test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set — skipping live deployment test");
		const ctx = readCtx();

		const createRes = await request.post("/api/issues", {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
			data: {
				projectId: ctx.grantedProjectId,
				title: "E2E mermaid rendering",
				body: `${GOOD}\n\n${BROKEN}`,
			},
		});
		expect(createRes.status()).toBe(201);
		const issue = (await createRes.json()) as { id: string };
		const shareRes = await request.post(`/api/issues/${issue.id}/share`, {
			headers: { "X-Workspace-Slug": ctx.workspaceSlug },
		});
		expect(shareRes.status()).toBe(201);
		const { token } = (await shareRes.json()) as { token: string };

		const publicContext = await page.context().browser()?.newContext({ colorScheme: "light" });
		const publicPage = await publicContext?.newPage();
		if (!publicPage) throw new Error("failed to create an unauthenticated browser context");

		try {
			await publicPage.goto(`/share/${token}`);
			const diagram = publicPage.locator("pre.mermaid svg");
			await expect(diagram).toHaveCount(1, { timeout: 30_000 });
			await expect(publicPage.locator(".mermaid-error")).toContainText(
				"Diagram failed to render"
			);
			await expect(publicPage.locator("pre.mermaid:not(:has(svg))")).toContainText("A --> --> B");

			const lightSvg = await diagram.first().innerHTML();
			await publicPage.evaluate(() =>
				document.documentElement.setAttribute("data-theme", "dark")
			);
			await expect
				.poll(async () => diagram.first().innerHTML(), { timeout: 15_000 })
				.not.toBe(lightSvg);
			await expect(diagram).toHaveCount(1);
		} finally {
			await publicContext?.close();
		}
	});
});
