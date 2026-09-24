#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as three jobs: ci (the shared
# XChain-Platform/.github ci-reusable.yml, with the perf suite opted in),
# drift-guards (this repo's own cross-repo byte-identity and pre-flight
# checks), and coverage (needs: ci). The pre-push venue gate used to run only
# `npm run ci`, so a push could gate green locally and then go red on GitHub
# on a job the gate never ran (2026-08-15: exactly that, on three repos at
# once). This script IS the local twin of the workflow: every job's
# run-steps, transcribed, in job order. When ci.yml gains or changes a job,
# change this script in the same commit.
#
# audit.yml is out of scope: it triggers on schedule/workflow_dispatch/a
# package.json-or-lockfile pull_request, never on a push to develop/master.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
# The ci job checks out every repo .ci-siblings declares and sets
# XCHAIN_REQUIRE_SIBLINGS=1 for the test gate, which turns every cross-repo
# guard's usual "sibling absent, skip" into a hard failure instead - this
# script needs every one of them present and passes the same env, so a
# locally-missing sibling can never gate green on a suite GitHub ran in full.
#
# No DB-backed tier: the SDK's suites (unit/security/regression/perf) need no
# database or vendored VM, unlike the indexer/hub siblings' gates.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "perf: hot-path throughput (test:performance)"
  "coverage ratchet (coverage:check)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
# >>> ci-tier timer (generated block; re-run the tier wirer to update) >>>
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
  local name="$1"; shift
  local __ci_tier_t0=$SECONDS
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS ($(( SECONDS - __ci_tier_t0 ))s)"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL ($(( SECONDS - __ci_tier_t0 ))s)"
  fi
}
# <<< ci-tier timer <<<
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

# Full .ci-siblings roster: the ci job's "check out declared sibling
# repositories" step clones every one of these beside this repo and sets
# XCHAIN_REQUIRE_SIBLINGS=1 for the test gate; the coverage job clones the
# same roster (without that env) so its measured percentage is not a
# skipped-guard undercount.
need_sib xchain-indexer xchain-contracts xchain-decoder xchain-hub \
  xchain-explorer xchain-documentation xchain-encoder xchain-vm \
  xchain-sync xchain-wallet

# --- job: ci (XChain-Platform/.github ci-reusable.yml) ---------------------
# run-perf: true, perf-script: test:performance. Siblings checked out above;
# XCHAIN_REQUIRE_SIBLINGS=1 mirrors the reusable workflow's test-gate step so
# every cross-repo guard actually runs instead of skipping green.
run_tier "ci (test gate, siblings required)" \
  env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci
run_tier "perf: hot-path throughput (test:performance)" npm run test:performance

# --- job: drift-guards -------------------------------------------------
# Steps without a working-directory run beside the sibling checkouts (the
# GitHub workspace root); steps with working-directory: xchain-sdk run here.
sync_coins_check() { (cd "$SIB" && xchain-hub/bin/sync-coins.sh --check --only xchain-sdk); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'
sync_abi_core_check() { (cd "$SIB" && xchain-explorer/bin/sync-abi-core.sh --check); }
run_tier "drift: contract abi-core byte-identity" sync_abi_core_check
run_tier "drift: explorer route contract" \
  env XCHAIN_REQUIRE_SIBLINGS=1 npx mocha test/unit/clients/explorer_route_contract.test.js
run_tier "drift: pre-flight <-> handler gate" \
  env XCHAIN_INDEXER_PATH="$SIB/xchain-indexer" XCHAIN_REQUIRE_SIBLINGS=1 \
  node bin/check-preflight-drift.js

# --- job: coverage (needs: ci) ----------------------------------------------
# Same sibling roster as the ci job (checked out again on GitHub, already
# present here); no XCHAIN_REQUIRE_SIBLINGS here, matching the workflow.
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
