import type { Env as ProjektorEnv } from "@projektor/types";

// vitest-pool-workers ≥0.13 types `cloudflare:test`'s `env` as `Cloudflare.Env`
// (the old `ProvidedEnv` interface was removed). Augment that global namespace
// with our binding shape so `env.DB` / `env.KV` / … are typed in tests.
declare global {
	namespace Cloudflare {
		interface Env extends ProjektorEnv {}
	}
}
