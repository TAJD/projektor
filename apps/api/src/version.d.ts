/**
 * Injected by esbuild's `--define` at release-build time (scripts/build-release.sh).
 * Undefined in local `wrangler dev` and in tests - callers must guard with `typeof`.
 */
declare const __PROJEKTOR_VERSION__: string;
