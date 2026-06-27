import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Wrangler 4 auto-loads a developer's local `apps/api/.dev.vars` into the test
// runtime, which would override the deterministic values in wrangler.test.toml
// (e.g. BOOTSTRAP_SECRET) and break tests for anyone who set up local dev.
// Re-apply wrangler.test.toml's [vars] as miniflare bindings — bindings are
// merged last, so the test config stays authoritative regardless of .dev.vars.
function testTomlVars(): Record<string, string> {
  const toml = readFileSync(new URL('./wrangler.test.toml', import.meta.url), 'utf8')
  const section = toml.split(/^\[/m).find((s) => s.startsWith('vars]'))
  if (!section) return {}
  const vars: Record<string, string> = {}
  for (const line of section.split('\n').slice(1)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/)
    if (m) vars[m[1]] = m[2]
  }
  return vars
}

export default defineConfig({
  // vitest-pool-workers ≥0.13 (vitest 4) exposes the Workers test runtime as a
  // plugin instead of `poolOptions.workers` / `defineWorkersConfig`.
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
      miniflare: {
        bindings: {
          // wrangler.test.toml is the source of truth for the test env.
          ...testTomlVars(),
          // The dev-only auth bypass must stay OFF in tests even if a
          // developer's .dev.vars sets DEV_USER_EMAIL (wrangler 4 loads
          // .dev.vars into the test runtime). Empty = bypass disabled.
          DEV_USER_EMAIL: '',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // workerd's unhandled-rejection detector spuriously flags the domain
    // ServiceErrors that MCP tool handlers throw and routes/mcp.ts catches: the
    // `async handler()` wrapper adds a promise-adoption hop the detector races.
    // These are expected — every failing test asserts the resulting JSON-RPC
    // error and passes. Suppress only our discriminated ServiceError kinds;
    // any other unhandled error still fails the run.
    onUnhandledError(error: { kind?: string }) {
      const KNOWN = ['validation', 'not_found', 'forbidden', 'conflict']
      if (error?.kind && KNOWN.includes(error.kind)) return false
    },
  },
})
