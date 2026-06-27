import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import { readFileSync } from 'node:fs'

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

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
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
      },
    },
    setupFiles: ['./src/test/setup.ts'],
  },
})
