/**
 * Emits llms.txt + llms-full.txt into the built site (dist/) for agent consumers.
 *
 * - llms.txt:      an index of pages with absolute URLs (the llmstxt.org convention).
 * - llms-full.txt: every page's markdown concatenated, for one-shot ingestion.
 *
 * Source is the same synced markdown the human site is built from, so the agent
 * view and the human view can never disagree. Runs after `astro build`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsApp = join(here, "..");
const contentDir = join(docsApp, "src", "content", "docs");
const distDir = join(docsApp, "dist");

const SITE = "https://tajd.github.io/projektor";

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (/\.mdx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

function parse(file) {
	const raw = readFileSync(file, "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	const fm = m ? m[1] : "";
	const body = m ? raw.slice(m[0].length) : raw;
	const title = (fm.match(/title:\s*"?(.*?)"?\s*$/m) || [])[1] || "Untitled";
	const description = (fm.match(/description:\s*"?(.*?)"?\s*$/m) || [])[1] || "";
	const slug = relative(contentDir, file)
		.replace(/\\/g, "/")
		.replace(/\.mdx?$/, "")
		.replace(/(^|\/)index$/, "");
	const url = slug ? `${SITE}/${slug}/` : `${SITE}/`;
	return { title, description, url, body };
}

if (!existsSync(distDir)) {
	console.error("dist/ not found — run `astro build` first.");
	process.exit(1);
}

const pages = walk(contentDir)
	.map(parse)
	.sort((a, b) => a.url.localeCompare(b.url));

// ── llms.txt: the index ──
const index = [
	"# Projektor",
	"",
	"> A self-hosted, MCP-native Jira + wiki that runs in a single Cloudflare Worker. AI agents are a first-class client over a JSON-RPC MCP endpoint.",
	"",
	"## Docs",
	"",
	...pages.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`),
	"",
];
writeFileSync(join(distDir, "llms.txt"), `${index.join("\n")}\n`, "utf8");

// ── llms-full.txt: everything inline ──
const full = [];
for (const p of pages) {
	full.push(`# ${p.title}`, "", `Source: ${p.url}`, "", p.body.trim(), "", "---", "");
}
writeFileSync(join(distDir, "llms-full.txt"), `${full.join("\n").trimEnd()}\n`, "utf8");

console.log(`Wrote llms.txt + llms-full.txt (${pages.length} pages)`);
