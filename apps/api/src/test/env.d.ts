import type { Env } from "@projektor/types";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
