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
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{html,css,js,svg,png,ico,json}'],
        runtimeCaching: [
          {
            urlPattern: /^\/(?:api|mcp)\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
            },
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
