import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
      // Ratchet target, not a ceiling — set a bit below the measured baseline
      // (~67% stmts/lines, ~78% branches, ~60% functions as of PROJ-223) so this
      // gates regressions without blocking on day one.
      thresholds: {
        statements: 60,
        branches: 70,
        functions: 55,
        lines: 60,
      },
    },
  },
});
