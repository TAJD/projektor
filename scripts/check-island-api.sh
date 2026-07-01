#!/usr/bin/env bash
# Enforce the island API convention: no raw fetch() or local buildHeaders in islands.
# See apps/web/src/utils/api-client.ts - islands must use apiFetch from there.

set -euo pipefail

ISLANDS_DIR="apps/web/src/islands"
ERRORS=0

while IFS= read -r line; do
  echo "ERROR: local buildHeaders declared in $line - remove it and use buildHeaders from utils/api-client.ts"
  ERRORS=$((ERRORS + 1))
done < <(grep -rn --include="*.ts" --include="*.tsx" \
  -E "(function buildHeaders|const buildHeaders)" \
  "$ISLANDS_DIR" | sed 's/:.*//')

while IFS= read -r match; do
  file=$(echo "$match" | cut -d: -f1)
  echo "ERROR: raw fetch() found in $file - use apiFetch from utils/api-client.ts instead"
  ERRORS=$((ERRORS + 1))
done < <(grep -rn --include="*.ts" --include="*.tsx" \
  -E "[^a-zA-Z0-9_.]fetch\(" \
  "$ISLANDS_DIR")

if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi

echo "Island API convention: OK"
