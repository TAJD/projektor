// Single source of truth for how the docs site describes Projektor and where it lives.
// Imported by astro.config.mjs, the route middleware (route-data.ts), the homepage and
// scripts/gen-llms-txt.mjs, so changing the product sentence or the domain is a one-line
// edit here.

/**
 * Canonical one-sentence product description. PROVISIONAL until PROJ-937 records the
 * final wording; when it does, change this line and nothing else.
 */
export const DESCRIPTION =
	"Projektor is an open-source, self-hosted, MCP-native issue tracker and wiki that runs in a single Cloudflare Worker.";

/** Origin the site is served from (Astro `site`). PROJ-949 may move this to a custom domain. */
export const SITE_ORIGIN = "https://tajd.github.io";

/** Path prefix the site is served under (Astro `base`). No trailing slash. */
export const BASE = "/projektor";

/** Absolute URL of the docs root, with a trailing slash. */
export const SITE_URL = `${SITE_ORIGIN}${BASE}/`;

export const REPO_URL = "https://github.com/TAJD/projektor";
export const DEPLOY_REPO_URL = "https://github.com/TAJD/projektor-deploy-example";
