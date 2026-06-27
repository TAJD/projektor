#!/usr/bin/env bash
# Build a self-contained projektor release artifact.
#
#   scripts/build-release.sh <version>
#
# Produces dist/projektor-<version>.tar.gz containing everything a consumer needs
# to deploy with only `wrangler` — no source, no node_modules, no build step:
#
#   worker.js              bundled, self-contained Worker (deps inlined)
#   web/                   pre-built Astro frontend (apps/web/dist)
#   migrations/            D1 migrations (packages/db/migrations)
#   wrangler.example.toml  config template (compatibility_date synced from source)
#   VERSION                the release version
#
# The consumer extracts this into ./vendor and points their wrangler.toml at it.
set -euo pipefail

VERSION="${1:?usage: build-release.sh <version> (e.g. v1.2.0)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGE="$ROOT/dist/release-stage"
OUT="$ROOT/dist"
TARBALL="$OUT/projektor-$VERSION.tar.gz"

echo "==> Cleaning staging dir"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"

echo "==> Building frontend (apps/web)"
pnpm --filter @projektor/web build

echo "==> Bundling worker (apps/api → self-contained worker.js)"
pnpm --filter @projektor/api build   # wrangler deploy --dry-run --outdir dist → apps/api/dist/index.js

echo "==> Staging artifact"
cp apps/api/dist/index.js "$STAGE/worker.js"
cp -r apps/web/dist "$STAGE/web"
cp -r packages/db/migrations "$STAGE/migrations"

echo "==> Writing wrangler.example.toml (compatibility_date synced from apps/api/wrangler.toml)"
COMPAT_DATE="$(sed -n 's/^compatibility_date = "\([^"]*\)".*/\1/p' apps/api/wrangler.toml)"
if [ -z "$COMPAT_DATE" ]; then
  echo "ERROR: could not read compatibility_date from apps/api/wrangler.toml" >&2
  exit 1
fi
sed "s/__COMPAT_DATE__/$COMPAT_DATE/" scripts/release-assets/wrangler.example.toml > "$STAGE/wrangler.example.toml"

echo "$VERSION" > "$STAGE/VERSION"

echo "==> Packing $TARBALL"
rm -f "$TARBALL"
tar -C "$STAGE" -czf "$TARBALL" .

echo ""
echo "Built $TARBALL"
( cd "$OUT" && ls -la "projektor-$VERSION.tar.gz" )
