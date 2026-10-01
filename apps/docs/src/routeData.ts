// Starlight route middleware (PROJ-939, PROJ-947): per-page <head> adjustments that
// frontmatter can't express because they depend on shared constants or the build.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
// The released version lives in the web app's package.json (bumped by release-prepare.yml).
import webPackage from "../../web/package.json";
import { DESCRIPTION, REPO_URL, SITE_URL } from "./site.mjs";

const SCREENSHOT_URL = "https://raw.githubusercontent.com/TAJD/projektor/main/docs/images/backlog.png";

const author = { "@type": "Person", name: "Thomas Dickson", url: "https://tom-dickson.com" };

// Homepage structured data. `codeRepository` belongs to SoftwareSourceCode, not
// SoftwareApplication, so the app and its source are two linked nodes in one graph.
// The site-wide WebSite node is emitted from astro.config.mjs.
const homepageGraph = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "SoftwareApplication",
			"@id": `${SITE_URL}#software`,
			name: "Projektor",
			description: DESCRIPTION,
			url: SITE_URL,
			applicationCategory: "DeveloperApplication",
			operatingSystem: "Cloudflare Workers",
			softwareVersion: webPackage.version,
			image: `${SITE_URL}og.png`,
			screenshot: SCREENSHOT_URL,
			author,
			license: "https://opensource.org/license/mit",
			offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
			sameAs: [REPO_URL],
		},
		{
			"@type": "SoftwareSourceCode",
			"@id": `${REPO_URL}#source`,
			name: "Projektor source code",
			codeRepository: REPO_URL,
			programmingLanguage: "TypeScript",
			runtimePlatform: "Cloudflare Workers",
			license: "https://opensource.org/license/mit",
			author,
			targetProduct: { "@id": `${SITE_URL}#software` },
		},
	],
};

// Base-aware link to a docs page: import.meta.env.BASE_URL is "/projektor/" today.
const docsPath = (slug: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/${slug}/`;

export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	if (route.id !== "") return;

	// Hero: canonical description as the first line under the H1, and the calls to
	// action. Set here rather than in index.mdx frontmatter so the sentence lives only
	// in site.mjs and the links follow the configured base.
	const hero = route.entry.data.hero;
	if (hero) {
		hero.tagline = DESCRIPTION;
		hero.actions = [
			{
				text: "Connect Claude Code",
				link: docsPath("agents/mcp-connection"),
				variant: "primary",
				icon: { type: "icon", name: "right-arrow" },
			},
			{
				text: "Star on GitHub",
				link: REPO_URL,
				variant: "secondary",
				icon: { type: "icon", name: "star" },
			},
			{
				text: "Self-host in 5 minutes",
				link: docsPath("guides/self-hosting"),
				variant: "minimal",
				icon: { type: "icon", name: "rocket" },
			},
		];
	}

	// Starlight hard-codes og:type=article on every page; the homepage is a website.
	for (const tag of route.head) {
		if (tag.tag === "meta" && tag.attrs?.property === "og:type") tag.attrs.content = "website";
	}
	route.head.push({
		tag: "script",
		attrs: { type: "application/ld+json" },
		content: JSON.stringify(homepageGraph),
	});
});
