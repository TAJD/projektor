import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwind from '@astrojs/tailwind';
import VitePWA from '@vite-pwa/astro';

export default defineConfig({
  output: 'static',
  redirects: {
    '/projects': '/',
  },
  integrations: [
    preact(),
    tailwind(),
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
        // PROJ-431: these are all dynamically imported and reached by a minority of
        // sessions (mermaid/cytoscape/katex render wiki diagrams and maths; the editor
        // only mounts on Edit). Precaching them cost 4.17 MiB on install and a
        // re-download on every deploy. They still load on demand over the network —
        // this only removes them from the install-time payload.
        // The real guard against regression is the precache budget asserted in
        // astro.config.precache.test.ts, not these patterns.
        globIgnores: [
          '**/mermaid*.js',
          '**/cytoscape*.js',
          '**/katex*.js',
          '**/cynefin*.js',
          '**/MarkdownEditor*.js',
          '**/*Diagram-*.js',
          '**/swimlanes-*.js',
          '**/cose-bilkent-*.js',
          '**/flow-charts*.js',
          '**/dagre-*.js',
          '**/ordinal-*.js',
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
    server: {
      proxy: {
        '/api': 'http://localhost:8787',
        '/mcp': 'http://localhost:8787',
      },
    },
  },
});
