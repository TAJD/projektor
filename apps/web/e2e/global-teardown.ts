/**
 * Playwright global teardown — runs once after all test workers finish.
 *
 * The test workspace created in globalSetup is intentionally left on the dev
 * deployment — there is no DELETE /api/workspaces endpoint.  The context file
 * is removed so stale run data does not bleed into the next invocation.
 */

import * as fs from "node:fs";
import { CTX_FILE } from "./global-setup";

export default async function globalTeardown(): Promise<void> {
	if (fs.existsSync(CTX_FILE)) {
		fs.unlinkSync(CTX_FILE);
		console.log("[e2e teardown] Context file removed.");
	}
}
