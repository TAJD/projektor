/**
 * Regenerates the tool-table block of the MCP tool catalog page from the live
 * MCP tool registry.
 *
 * The page itself — frontmatter and intro prose — is an ordinary committed
 * Starlight file (apps/docs/src/content/docs/agents/tool-catalog.md). This script
 * owns ONLY the block between the `gen-mcp-catalog:start` / `:end` markers: the
 * tool tables, which must track the code. Everything outside the markers is
 * hand-edited like any other page.
 *
 * The tool arrays in apps/api/src/mcp/*.ts are the source of truth. CI runs this
 * and fails if the committed file is stale (see .github/workflows/ci.yml).
 *
 *   pnpm --filter @projektor/api gen:catalog
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_COUNT, TOOL_DOMAINS } from "../src/mcp/catalog";

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
	"tool-catalog.md",
);
const statsPath = join(repoRoot, "apps", "docs", "src", "generated", "mcp-stats.json");
const readmePath = join(repoRoot, "README.md");

const START = "<!-- gen-mcp-catalog:start";
const END = "<!-- gen-mcp-catalog:end -->";

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

const groups = ["Coordination", "Project data"] as const;
const domainCount = TOOL_DOMAINS.length;

// ── Render just the generated block (count + tables) ──
const body: string[] = [];
body.push(`**${TOOL_COUNT} tools across ${domainCount} domains.**`);
body.push("");
for (const group of groups) {
	const domains = TOOL_DOMAINS.filter((d) => d.group === group);
	if (domains.length === 0) continue;
	body.push(`## ${group}`);
	body.push("");
	for (const d of domains) {
		body.push(`### ${d.title}`);
		body.push("");
		body.push("| Tool | Description |");
		body.push("|------|-------------|");
		body.push(...d.tools.map((t) => `| \`${escapeCell(t.name)}\` | ${escapeCell(t.description)} |`));
		body.push("");
	}
}
const middle = body.join("\n").trimEnd();

// ── Splice it between the markers, preserving everything else verbatim ──
const existing = readFileSync(outPath, "utf8");
const startIdx = existing.indexOf(START);
const endIdx = existing.indexOf(END);
if (startIdx === -1 || endIdx === -1) {
	throw new Error(
		`Could not find the "${START} … ${END}" markers in ${outPath}. ` +
			"The page must keep them so the generator knows which block to rewrite.",
	);
}
const startLineEnd = existing.indexOf("\n", startIdx);
const head = existing.slice(0, startLineEnd + 1); // through the start-marker line
const tail = existing.slice(endIdx); // from the end-marker line onward

writeFileSync(outPath, `${head}\n${middle}\n\n${tail}`, "utf8");

// ── Emit the raw counts for other surfaces (system-design.mdx, README) to import ──
mkdirSync(dirname(statsPath), { recursive: true });
writeFileSync(
	statsPath,
	`${JSON.stringify({ tools: TOOL_COUNT, domains: domainCount }, null, "\t")}\n`,
	"utf8",
);

// ── Rewrite the marked stats block in README.md ──
const README_START = "<!-- gen-mcp-stats:start -->";
const README_END = "<!-- gen-mcp-stats:end -->";
const readme = readFileSync(readmePath, "utf8");
const readmeStart = readme.indexOf(README_START);
const readmeEnd = readme.indexOf(README_END);
if (readmeStart === -1 || readmeEnd === -1) {
	throw new Error(
		`Could not find the "${README_START} … ${README_END}" markers in ${readmePath}. ` +
			"README.md must keep them so the generator knows which text to rewrite.",
	);
}
const readmeHead = readme.slice(0, readmeStart + README_START.length);
const readmeTail = readme.slice(readmeEnd);
writeFileSync(
	readmePath,
	`${readmeHead}${TOOL_COUNT} tools across ${domainCount} domains${readmeTail}`,
	"utf8",
);

// cofferdam-ignore: Warning.NoConsoleLog: CLI generator script output, not a debug leftover
console.log(`Updated tool table in ${outPath} (${TOOL_COUNT} tools, ${domainCount} domains)`);
