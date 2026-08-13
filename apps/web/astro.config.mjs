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
    server: {
      proxy: {
        '/api': 'http://localhost:8787',
        '/mcp': 'http://localhost:8787',
      },
    },
  },
});
