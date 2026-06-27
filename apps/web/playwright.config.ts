import { defineConfig, devices } from "@playwright/test";

// E2E_BASE_URL must point at a deployed dev instance.
// API calls are made to the same origin under /api/*, so both the frontend
// and the Cloudflare Worker must be reachable at that URL.
const baseURL = process.env.E2E_BASE_URL;

// Auth headers injected into every Playwright browser request so they bypass
// both Cloudflare Access and the app's own bearer-token middleware.
// All four are read from env vars; never hardcode values here.
const extraHTTPHeaders: Record<string, string> = {
	"X-Workspace-Slug": process.env.PUBLIC_WORKSPACE_SLUG ?? "projektor",
};
if (process.env.CF_ACCESS_CLIENT_ID)
	extraHTTPHeaders["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
if (process.env.CF_ACCESS_CLIENT_SECRET)
	extraHTTPHeaders["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
if (process.env.PROJEKTOR_API_TOKEN)
	extraHTTPHeaders["Authorization"] = `Bearer ${process.env.PROJEKTOR_API_TOKEN}`;

export default defineConfig({
	testDir: "./e2e",
	// Single worker: the two projects share one seeded workspace created in
	// globalSetup; serialising avoids any cross-project race on that data.
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: [["html", { open: "never" }]],
	globalSetup: "./e2e/global-setup",
	globalTeardown: "./e2e/global-teardown",

	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		extraHTTPHeaders,
	},

	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "mobile",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 375, height: 812 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],
});
