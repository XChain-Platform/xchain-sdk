#!/usr/bin/env bash
# Moves the ../xchain-contracts sibling to the commit this SDK is tested against.
#
# WHY: the shared checkout-siblings action takes ONE ref for every sibling, and
# xchain-contracts master trails its develop by a release. On a master or tag run
# the template-parity tests then read templates the SDK has already moved past and
# fail, which left a tagged release unpublished. The commit lives in
# bin/pins/xchain-contracts-commit.txt and is bumped deliberately with the SDK.
#
# Fails loudly: a missing or malformed pin, or a commit that cannot be fetched,
# stops the job rather than testing against whatever the clone happened to hold.
set -euo pipefail

ROOT="$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(realpath "$ROOT")"
PIN_FILE="$ROOT/bin/pins/xchain-contracts-commit.txt"
SIBLING="${CONTRACTS_DIR:-$ROOT/../xchain-contracts}"

if [ ! -f "$PIN_FILE" ]; then
  echo "::error::pin file missing: $PIN_FILE" >&2
  exit 1
fi
SHA="$(tr -d '[:space:]' < "$PIN_FILE")"
if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "::error::$PIN_FILE does not hold a 40-hex commit sha" >&2
  exit 1
fi
if [ ! -d "$SIBLING/.git" ]; then
  echo "::error::sibling checkout missing: $SIBLING" >&2
  exit 1
fi

git -C "$SIBLING" fetch --quiet --depth 1 origin "$SHA" \
  || { echo "::error::cannot fetch xchain-contracts commit $SHA" >&2; exit 1; }
git -C "$SIBLING" checkout --quiet --detach "$SHA"
echo "sibling xchain-contracts pinned @ $(git -C "$SIBLING" rev-parse HEAD)"

# Same runtime-only install the siblings action does, so the pinned tree's deps match its package.json.
if [ -f "$SIBLING/package.json" ]; then
  npm --prefix "$SIBLING" ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
    || npm --prefix "$SIBLING" install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
    || echo "sibling xchain-contracts: dependency install failed, guards needing its modules will say so"
fi
