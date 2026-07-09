/**
 * PROJ-313: two-user confinement check for group-access (PROJ-311).
 *
 * Verifies that a member scoped to a group (granted one project only) cannot
 * see or reach an ungranted project. Requires a real, workspace-scoped member
 * API token: dev-bypass authenticates every request as the workspace owner,
 * and workspace-scoped tokens can only be minted by their owner against a
 * workspace they already belong to — they can't be auto-minted for the
 * invited member in the ephemeral e2e workspace. So this suite is env-gated
 * and skipped unless a real member token is supplied out-of-band.
 *
 * Prerequisites: globalSetup must have written e2e/.e2e-ctx.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { E2EContext } from "./global-setup";

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

const SKIP_REASON =
	"E2E_BASE_URL, E2E_MEMBER_TOKEN, and E2E_MEMBER_EMAIL are all required — a real, " +
	"workspace-scoped member API token for the invited member is needed and cannot be " +
	"auto-minted for the ephemeral e2e workspace.";

test.describe("Group-access confinement (member)", () => {
	let memberRequest: APIRequestContext;

	test.beforeAll(async ({ playwright }) => {
		if (!process.env.E2E_BASE_URL || !process.env.E2E_MEMBER_TOKEN || !process.env.E2E_MEMBER_EMAIL)
			return;

		const ctx = readCtx();
		memberRequest = await playwright.request.newContext({
			baseURL: process.env.E2E_BASE_URL,
			extraHTTPHeaders: {
				Authorization: `Bearer ${process.env.E2E_MEMBER_TOKEN}`,
				"X-Workspace-Slug": ctx.workspaceSlug,
			},
		});
	});

	test.afterAll(async () => {
		await memberRequest?.dispose();
	});

	test("member sees only the granted project", async () => {
		test.skip(
			!process.env.E2E_BASE_URL || !process.env.E2E_MEMBER_TOKEN || !process.env.E2E_MEMBER_EMAIL,
			SKIP_REASON
		);

		const ctx = readCtx();
		const res = await memberRequest.get("/api/projects");
		expect(res.ok()).toBe(true);
		const projects = (await res.json()) as Array<{ id: string }>;

		expect(projects.some((p) => p.id === ctx.grantedProjectId)).toBe(true);
		expect(projects.some((p) => p.id === ctx.ungrantedProjectId)).toBe(false);
	});

	test("member 404s on an ungranted project", async () => {
		test.skip(
			!process.env.E2E_BASE_URL || !process.env.E2E_MEMBER_TOKEN || !process.env.E2E_MEMBER_EMAIL,
			SKIP_REASON
		);

		const ctx = readCtx();
		const res = await memberRequest.get(`/api/projects/${ctx.ungrantedProjectId}`);
		expect(res.status()).toBe(404);
	});
});
