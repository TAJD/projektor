/// <reference types="astro/client" />

// vite-plugin-pwa's own `vite-plugin-pwa/vanillajs` ambient types aren't picked
// up via a triple-slash reference inside Base.astro's <script> block by
// `astro check` (PROJ-418), so the declaration is inlined here instead.
declare module "virtual:pwa-register" {
	import type { RegisterSWOptions } from "vite-plugin-pwa/types";

	export type { RegisterSWOptions };

	export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
