/**
 * Per-page <lastmod> for the sitemap (PROJ-947).
 *
 * Source: the committer date of the last git commit that touched the page's source
 * file under src/content/docs. @astrojs/sitemap only supports one global `lastmod`,
 * so astro.config.mjs passes each URL through `lastmodFor` in its `serialize` hook.
 *
 * A shallow clone (CI's default checkout) would give every page the same date, which
 * is worse than none, so in that case no lastmod is emitted. The docs deploy workflow
 * checks out full history for this reason.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, SITE_ORIGIN } from "../src/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "src", "content", "docs");

function git(args) {
	try {
		return execFileSync("git", args, { cwd: contentDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

const usable = git(["rev-parse", "--is-shallow-repository"]) === "false";
const cache = new Map();

/** Source file for a sitemap URL, e.g. https://…/projektor/guides/live-demo/ → guides/live-demo.md */
function sourceFor(url) {
	const prefix = `${SITE_ORIGIN}${BASE}/`;
	if (!url.startsWith(prefix)) return undefined;
	const slug = url.slice(prefix.length).replace(/\/$/, "") || "index";
	for (const ext of [".md", ".mdx"]) {
		for (const candidate of [`${slug}${ext}`, `${slug}/index${ext}`]) {
			if (existsSync(join(contentDir, candidate))) return candidate;
		}
	}
	return undefined;
}

/** ISO date of the last commit touching the page behind `url`, or undefined. */
export function lastmodFor(url) {
	if (!usable) return undefined;
	const file = sourceFor(url);
	if (!file) return undefined;
	if (!cache.has(file)) {
		const date = git(["log", "-1", "--format=%cI", "--", file]);
		cache.set(file, date ? new Date(date).toISOString() : undefined);
	}
	return cache.get(file);
}
