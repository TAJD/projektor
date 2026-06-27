/**
 * Single-source content sync for the docs site.
 *
 * The canonical markdown lives at the repo root (README.md, AGENTS.md, docs/*.md).
 * This script copies it into src/content/docs/ with the Starlight frontmatter the
 * docs collection requires, rewriting cross-document links to their site routes.
 *
 * src/content/docs/ is therefore 100% generated and gitignored — never edit it by
 * hand; edit the canonical file and re-run (`pnpm --filter @projektor/docs sync:content`).
 *
 * The MCP tool catalog (docs/mcp-tools.generated.md) is itself generated from code by
 * apps/api/scripts/gen-mcp-catalog.ts — run `pnpm --filter @projektor/api gen:catalog`
 * first if you changed any tool.
 *
 * This script also emits public/llms.txt and public/llms-full.txt so they are served
 * at the docs site root. Astro copies public/ to dist/ automatically during the build.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsApp = join(here, "..");
const repoRoot = join(docsApp, "..", "..");
const outDir = join(docsApp, "src", "content", "docs");

const BASE = "/projektor";
const GH = "https://github.com/TAJD/projektor";

/** source (repo-relative) → { slug, title, description, order within sidebar group } */
const PAGES = [
	{
		src: "README.md",
		slug: "guides/self-hosting",
		order: 1,
		title: "Self-hosting Projektor",
		description: "Deploy your own Projektor instance on Cloudflare in five minutes.",
	},
	{
		src: "docs/deploying.md",
		slug: "guides/deploying",
		order: 2,
		title: "Deploying & operating",
		description:
			"The deployment model in full: release artifacts, config-only deploys, the Cloudflare API token, secrets, and automatic updates.",
	},
	{
		src: "docs/mcp.md",
		slug: "agents/mcp-connection",
		order: 1,
		title: "Connect an AI agent",
		description: "Connect Claude Code or any MCP-compatible agent to your Projektor instance.",
	},
	{
		src: "docs/mcp-tools.generated.md",
		slug: "agents/tool-catalog",
		order: 2,
		title: "MCP tool catalog",
		description: "Every MCP tool Projektor exposes, generated from source.",
	},
	{
		src: "docs/agent-workflows.md", // optional; synced once it exists
		slug: "agents/agent-workflows",
		order: 3,
		title: "Agentic workflows",
		description: "The end-to-end multi-agent loop: lifecycle, coordination, and project management.",
	},
	{
		src: "docs/marketecture.md",
		slug: "architecture/system-design",
		order: 1,
		title: "System design",
		description: "How Projektor is put together: surfaces, service layer, and storage.",
	},
	{
		src: "AGENTS.md",
		slug: "contributing/conventions",
		order: 1,
		title: "Contributor conventions",
		description: "Architecture contract and conventions for working on the Projektor codebase.",
	},
];

/** Rewrite cross-document markdown links to their site routes. */
function rewriteLinks(md) {
	const fileRoutes = {
		"README.md": `${BASE}/guides/self-hosting/`,
		"deploying.md": `${BASE}/guides/deploying/`,
		"AGENTS.md": `${BASE}/contributing/conventions/`,
		"mcp.md": `${BASE}/agents/mcp-connection/`,
		"mcp-tools.generated.md": `${BASE}/agents/tool-catalog/`,
		"agent-workflows.md": `${BASE}/agents/agent-workflows/`,
		"marketecture.md": `${BASE}/architecture/system-design/`,
	};
	return md.replace(/\]\(([^)]+)\)/g, (whole, target) => {
		if (/^(https?:|mailto:|#)/.test(target)) return whole;
		const [path, anchor] = target.split("#");
		const clean = path.replace(/^\.\//, "").replace(/(\.\.\/)+/g, "");
		const base = clean.split("/").pop();
		const route = fileRoutes[clean] || fileRoutes[base];
		if (route) return `](${route}${anchor ? `#${anchor}` : ""})`;
		return whole;
	});
}

/** Pull the first H1 off the top and return [title, body]. */
function splitTitle(md) {
	const lines = md.split("\n");
	const i = lines.findIndex((l) => l.startsWith("# "));
	if (i === -1) return [null, md];
	// keep any leading HTML comments (e.g. the generated banner) before the H1
	const title = lines[i].slice(2).trim();
	lines.splice(i, 1);
	return [title, lines.join("\n").replace(/^\n+/, "")];
}

function yamlString(s) {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Splash landing page (site chrome — short hero, links into synced docs) ──
const INDEX = `---
title: Projektor
description: A self-hosted, MCP-native Jira + wiki that runs in a single Cloudflare Worker.
template: splash
hero:
  tagline: A self-hosted Jira + wiki, MCP-native, running entirely on Cloudflare's edge. AI agents are a first-class client — not an afterthought.
  actions:
    - text: Connect an agent
      link: ${BASE}/agents/mcp-connection/
      icon: right-arrow
      variant: primary
    - text: Self-host in 5 minutes
      link: ${BASE}/guides/self-hosting/
      icon: rocket
    - text: GitHub
      link: ${GH}
      icon: github
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

<CardGrid stagger>
  <Card title="MCP-native" icon="puzzle">
    Every action available in the browser is available to an agent over JSON-RPC. The MCP server is the primary surface.
  </Card>
  <Card title="Edge-native" icon="cloudflare">
    Hono on Cloudflare Workers. D1 for data, KV for sessions, R2 for attachments. No servers, no containers.
  </Card>
  <Card title="Built for fleets" icon="seti:notebook">
    Agent sessions, file claims, and coordination messages let parallel agents work the same repo without colliding.
  </Card>
  <Card title="Dogfooded" icon="approve-check">
    Projektor's own roadmap is tracked inside Projektor. The docs you're reading are generated from the same repo.
  </Card>
</CardGrid>
`;

// ── Run ──
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.mdx"), INDEX, "utf8");

let synced = 0;
const skipped = [];
for (const page of PAGES) {
	const srcPath = join(repoRoot, page.src);
	if (!existsSync(srcPath)) {
		skipped.push(page.src);
		continue;
	}
	const raw = readFileSync(srcPath, "utf8");
	const [, body] = splitTitle(raw);
	const frontmatter = [
		"---",
		`title: ${yamlString(page.title)}`,
		`description: ${yamlString(page.description)}`,
		"sidebar:",
		`  order: ${page.order}`,
		"---",
		"",
	].join("\n");
	const outPath = join(outDir, `${page.slug}.md`);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, frontmatter + rewriteLinks(body), "utf8");
	synced++;
}

// ── Copy the brand font so the docs site matches the app exactly ──
const fontSrc = join(repoRoot, "apps", "web", "public", "fonts", "MonaspaceNeon-Variable.woff2");
const fontDir = join(docsApp, "public", "fonts");
if (existsSync(fontSrc)) {
	mkdirSync(fontDir, { recursive: true });
	cpSync(fontSrc, join(fontDir, "MonaspaceNeon-Variable.woff2"));
}

console.log(`Synced ${synced} pages -> ${outDir}`);
if (skipped.length) console.log(`Skipped (not present yet): ${skipped.join(", ")}`);

// ── llms.txt + llms-full.txt ──
const SITE = "https://tajd.github.io/projektor";
const publicDir = join(docsApp, "public");
mkdirSync(publicDir, { recursive: true });

const sectionLabels = {
	guides: "Guides",
	agents: "Agents & MCP",
	architecture: "Architecture",
	contributing: "Contributing",
};

// Collect available pages grouped by top-level section, preserving PAGES order.
const groups = {};
for (const page of PAGES) {
	if (!existsSync(join(repoRoot, page.src))) continue;
	const section = page.slug.split("/")[0];
	if (!groups[section]) groups[section] = [];
	groups[section].push(page);
}

// llms.txt — index with absolute URLs (llmstxt.org convention)
const indexLines = [
	"# Projektor",
	"",
	"> A self-hosted, MCP-native Jira + wiki that runs in a single Cloudflare Worker. AI agents are a first-class client over a JSON-RPC MCP endpoint.",
	"",
];
for (const [section, pages] of Object.entries(groups)) {
	indexLines.push(`## ${sectionLabels[section] || section}`, "");
	for (const p of pages) {
		indexLines.push(`- [${p.title}](${SITE}/${p.slug}/): ${p.description}`);
	}
	indexLines.push("");
}
writeFileSync(join(publicDir, "llms.txt"), indexLines.join("\n") + "\n", "utf8");

// llms-full.txt — every page's markdown concatenated, for one-shot ingestion
const fullLines = [];
for (const [, pages] of Object.entries(groups)) {
	for (const p of pages) {
		const srcPath = join(repoRoot, p.src);
		const raw = readFileSync(srcPath, "utf8");
		const [, body] = splitTitle(raw);
		fullLines.push(`# ${p.title}`, "", `Source: ${SITE}/${p.slug}/`, "", body.trim(), "", "---", "");
	}
}
writeFileSync(join(publicDir, "llms-full.txt"), fullLines.join("\n").trimEnd() + "\n", "utf8");

console.log("Wrote public/llms.txt + public/llms-full.txt");
