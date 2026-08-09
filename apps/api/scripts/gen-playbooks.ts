/**
 * Regenerates the playbook docs pages (each has no hand-edited prose, like
 * workflow-spec.md) from the single source of truth in
 * src/services/playbook-content.ts.
 *
 * CI runs this and fails if the committed files are stale (see
 * .github/workflows/ci.yml), the same pattern as gen-workflow-spec.ts.
 *
 *   pnpm --filter @projektor/api gen:playbooks
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYBOOKS } from "../src/services/playbook-content";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", ".."); // apps/api/scripts -> repo root
const outDir = join(repoRoot, "apps", "docs", "src", "content", "docs", "agents", "playbooks");

mkdirSync(outDir, { recursive: true });

// Clear stale entries (a renamed/removed playbook) before writing the current set,
// same reasoning as any generated-directory sync step.
for (const entry of readdirSync(outDir)) {
	rmSync(join(outDir, entry));
}

for (const playbook of PLAYBOOKS) {
	const frontmatter = [
		"---",
		`title: "${playbook.title}"`,
		`description: "${playbook.description}"`,
		"sidebar:",
		`  order: ${playbook.sidebarOrder}`,
		"---",
	].join("\n");

	const outPath = join(outDir, `${playbook.name}.md`);
	writeFileSync(outPath, `${frontmatter}\n${playbook.body}`, "utf8");
	// cofferdam-ignore: Warning.NoConsoleLog: CLI generator script output, not a debug leftover
	console.log(`Updated ${outPath}`);
}
