import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';
import VitePWA from '@vite-pwa/astro';
import { lazyOnlyChunkNames } from './scripts/lazy-only-chunks.mjs';

// Populated during the client build and read back when workbox generates its precache
// manifest, which happens later in the same process (astro:build:done).
let lazyOnlyChunks = new Set();

function collectLazyOnlyChunks() {
  return {
    name: 'projektor:collect-lazy-only-chunks',
    apply: 'build',
    generateBundle(_options, bundle) {
      // The prerender and SSR builds emit their own chunks; only the client bundle's
      // graph says anything about what a browser loads eagerly.
      if (this.environment?.name !== 'client') return;
      lazyOnlyChunks = lazyOnlyChunkNames(bundle);
    },
  };
}

export default defineConfig({
  output: 'static',
  // No `security.csp` here on purpose (PROJ-645). Astro's built-in CSP emits a <meta>
  // tag and always appends a hash for every <style> block it inlines — including its own
  // `astro-island{display:contents}`, which no config removes. CSP ignores 'unsafe-inline'
  // in any directive that carries a hash, and mermaid and CodeMirror both inject styles at
  // runtime that cannot be hashed at build time, so astro's mechanism cannot express a
  // policy that leaves those two working. Measured, not inferred: with it enabled, mermaid
  // renders an unstyled diagram and mounting the editor logs 15 violations.
  // scripts/gen-csp-headers.mjs writes the policy as a real response header instead.
  redirects: {
    '/projects': '/',
  },
  integrations: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      // @vite-pwa/astro doesn't inject a registration <script> into Astro's
      // built pages the way vite-plugin-pwa does for a plain Vite index.html
      // (PROJ-418) — registration is wired up manually in Base.astro instead,
      // via the `virtual:pwa-register` module.
      injectRegister: null,
      workbox: {
        // Load-bearing: vite-plugin-pwa's own defaults set navigateFallback to
        // 'index.html', so omitting this key silently re-enables the fallback
        // (and, with no HTML precached, createHandlerBoundToURL then throws at
        // service-worker install time). It has to be explicitly undefined.
        navigateFallback: undefined,
        // PROJ-430: deliberately no navigation fallback and no HTML in the precache.
        // Every page here sits behind Cloudflare Access, and Access can only
        // refresh an expired session by challenging a real network navigation.
        // Precached HTML + navigateFallback answered navigations cache-first, so
        // reload-to-re-auth (PROJ-427) and the sidebar Log in / Log out links
        // never left the device — an expired tab just 401ed and reloaded forever.
        // Assets stay precached; navigations must hit the network.
        globPatterns: ['**/*.{css,js,svg,png,ico,json}'],
        // PROJ-431, rebuilt for PROJ-302: drop everything only reachable through a dynamic
        // import. Those chunks cost 4.17 MiB on install and a re-download on every deploy;
        // they still load on demand over the network. The regression guard is the precache
        // budget asserted by scripts/assert-sw.mjs as a post-build step.
        manifestTransforms: [
          (entries) => ({
            manifest: entries.filter((entry) => !lazyOnlyChunks.has(entry.url)),
          }),
        ],
        runtimeCaching: [
          {
            urlPattern: /^\/(?:api|mcp)\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  vite: {
    // Tailwind v4 is a Vite plugin rather than an Astro integration; @astrojs/tailwind is
    // deprecated and was the only thing pinning astro to 5 (PROJ-302).
    plugins: [tailwindcss(), collectLazyOnlyChunks()],
    build: {
      rollupOptions: {
        output: {
          // PROJ-868: the actual culprit (confirmed via a one-off `moduleIds` dump of
          // the offending chunk) is the synthetic `\0rolldown/runtime.js` module —
          // rolldown's own tiny generated interop helper, not a real npm package. Both
          // @preact/signals-core and mermaid's bundled d3-selection/dayjs code need it,
          // and rolldown's automatic "commons" chunking put the helper inside the same
          // physical chunk as mermaid's d3-selection + dayjs code (an anonymous
          // `src.<hash>.js`) rather than splitting it out on its own — so every
          // client:load island that imports @preact/signals (ProjectNav, WikiPage,
          // IssueList, ...) pulled that whole chunk in, 16 KB gzip on every page even
          // when no mermaid diagram was ever rendered (see apps/web/scripts/
          // assert-eager-chunks.mjs, which asserts this never regresses).
          //
          // Pinning the runtime helper to its own near-empty chunk breaks that fusion:
          // mermaid's own d3-selection/dayjs modules go back to being purely part of
          // mermaid's lazy-loaded graph, and @preact/signals-core picks up the helper
          // from a chunk with nothing else eager-vs-lazy-conflicting in it.
          manualChunks(id) {
            if (id === '\0rolldown/runtime.js') return 'rolldown-runtime';
            if (id.includes('node_modules') && /[/\\]@preact[/\\]signals(-core)?[/\\]/.test(id)) {
              return 'preact-signals';
            }
            // Required, not just belt-and-suspenders: removing this rule and rebuilding
            // still fails assert-eager-chunks.mjs — pinning only the runtime helper above
            // isn't enough, because rolldown's "commons" heuristic re-merges d3-selection
            // and dayjs (the two modules that made the runtime-helper chunk "big" in the
            // first place) right back into it on its own. Naming them explicitly here is
            // what actually keeps mermaid's bundled d3-selection/dayjs code out of the
            // chunk @preact/signals-core needs eagerly.
            if (
              id.includes('node_modules') &&
              /[/\\](d3-selection|d3-dispatch|dayjs)[/\\]/.test(id)
            ) {
              return 'mermaid-shared-vendor';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': 'http://localhost:8787',
        '/mcp': 'http://localhost:8787',
      },
    },
  },
});
