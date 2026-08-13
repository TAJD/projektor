import { defineConfig } from 'vitest/config';

// No transformer block here on purpose. vitest 4 transforms with oxc rather than esbuild, and
// warns that it is ignoring any `esbuild` options it finds — so the `jsx`/`jsxImportSource` pair
// this file used to carry had become dead config. oxc reads them from tsconfig.json instead,
// which is load-bearing: point tsconfig's jsxImportSource at anything but preact and every .tsx
// test fails to transform.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
      // Ratchet target, not a ceiling — set a bit below the measured baseline so this gates
      // regressions without blocking on day one.
      //
      // Re-baselined for vitest 4 (PROJ-302), which changed what these numbers mean rather than
      // what the tests cover. coverage-v8 3 shipped two remappers and defaulted to the
      // sourcemap-based one, with the AST-aware remapper behind `experimentalAstAwareRemapping`;
      // v4 deleted the legacy path, so AST-aware is now the only mode and there is no flag to
      // get the old figures back. Mapping to real AST branch nodes instead of sourcemap line
      // ranges sees branches the old remapper never counted, so measured branch coverage fell
      // from ~78% to 64.38% on an unchanged, fully passing suite; statements, functions and
      // lines all moved up on the same re-measure. All four are set from the v4 numbers
      // (72.71 / 64.38 / 71.02 / 75.04) — the old ones are not comparable.
      thresholds: {
        statements: 70,
        branches: 62,
        functions: 68,
        lines: 72,
      },
    },
  },
});
