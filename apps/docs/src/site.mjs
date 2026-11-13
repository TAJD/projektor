// Single source of truth for how the docs site describes Projektor and where it lives.
// Imported by astro.config.mjs, the route middleware (routeData.ts), the homepage and
// scripts/gen-llms-txt.mjs, so changing the product sentence or the domain is a one-line
// edit here.

/** Canonical one-sentence product description (PROJ-937). */
export const DESCRIPTION =
	"Projektor is open-source, internet-scale task management for AI agents and humans: a tracker and wiki on Cloudflare that any agent can reach over MCP.";

/** Origin the site is served from (Astro `site`). PROJ-949: no custom domain, stays on GitHub Pages. */
export const SITE_ORIGIN = "https://tajd.github.io";

/** Path prefix the site is served under (Astro `base`). No trailing slash. */
export const BASE = "/projektor";

/** Absolute URL of the docs root, with a trailing slash. */
export const SITE_URL = `${SITE_ORIGIN}${BASE}/`;

export const REPO_URL = "https://github.com/TAJD/projektor";
