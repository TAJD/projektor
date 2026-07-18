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
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{html,css,js,svg,png,ico,json}'],
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
