/**
 * Injected by esbuild's `--define` at release-build time (scripts/build-release.sh).
 * Undefined in local `wrangler dev` and in tests - callers must guard with `typeof`.
 * The dogfood deploy path (local wrangler-OAuth post-commit hook, outside this repo)
 * does not run build-release.sh, so it intentionally reports "dev" - only versioned
 * release tarballs get a real version string.
 */
declare const __PROJEKTOR_VERSION__: string | undefined;
