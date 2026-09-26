// PROJ-884 (and PROJ-896's "ban tenant retargeting of ctx"): no MCP handler or service
// may rebuild a ServiceCtx pointing at a different workspace. ctx.role and token
// confinement describe the workspace the middleware resolved; swapping workspaceId
// after the fact bypasses both (that is exactly how delete_workspace deleted other
// tenants' workspaces). Runs in node because it reads source off disk.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");
const RETARGET = /\{\s*\.\.\.ctx\s*,\s*workspaceId\s*:/;

function tsFiles(dir: string): string[] {
	return readdirSync(join(SRC, dir))
		.filter((f) => f.endsWith(".ts"))
		.map((f) => join(dir, f));
}

describe("no ServiceCtx workspace retargeting", () => {
	it("apps/api/src/{mcp,services} never spread ctx with a new workspaceId", () => {
		const offenders = [...tsFiles("mcp"), ...tsFiles("services")].filter((f) =>
			RETARGET.test(readFileSync(join(SRC, f), "utf8"))
		);
		expect(offenders).toEqual([]);
	});
});
