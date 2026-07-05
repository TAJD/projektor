/**
 * Regenerates the workflow-spec docs page (in full — this page has no hand-edited
 * prose, unlike tool-catalog.md) from the single source of truth in
 * src/services/workflow-content.ts.
 *
 * CI runs this and fails if the committed file is stale (see .github/workflows/ci.yml).
 *
 *   pnpm --filter @projektor/api gen:workflow-spec
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_SPEC } from "../src/services/workflow-content";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", ".."); // apps/api/scripts -> repo root
const outPath = join(
	repoRoot,
	"apps",
	"docs",
	"src",
	"content",
	"docs",
	"agents",
	"workflow-spec.md"
);

const frontmatter = [
	"---",
	`title: "${WORKFLOW_SPEC.title}"`,
	`description: "${WORKFLOW_SPEC.description}"`,
	"sidebar:",
	`  order: ${WORKFLOW_SPEC.sidebarOrder}`,
	"---",
].join("\n");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${frontmatter}\n${WORKFLOW_SPEC.body}`, "utf8");

// cofferdam-ignore: Warning.NoConsoleLog: CLI generator script output, not a debug leftover
console.log(`Updated ${outPath}`);
