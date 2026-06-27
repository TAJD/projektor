#!/usr/bin/env bash
# Run once after cloning your deploy repo to provision CF resources
# and configure secrets. Requires wrangler to be installed globally.
set -e

echo "==> Creating D1 database..."
wrangler d1 create projektor

echo ""
echo "==> Creating KV namespace..."
wrangler kv namespace create projektor

echo ""
echo "==> Creating R2 bucket..."
wrangler r2 bucket create projektor-files

echo ""
echo "Paste the IDs above into wrangler.toml, then run:"
echo ""
echo "  wrangler secret put JWT_SECRET"
echo ""
echo "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUDIENCE in wrangler.toml"
echo "or as secrets:"
echo ""
echo "  wrangler secret put CF_ACCESS_TEAM_DOMAIN"
echo "  wrangler secret put CF_ACCESS_AUDIENCE"
