/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - pre-flight constants and finding-code registry
 *
 * Single normative home (spec §8.7) for every pre-flight finding code,
 * the certified Tier-2 error-capable list, and every quantified
 * constant. Tests assert against this module, never against literals;
 * a second list anywhere is a spec violation.
 *
 ********************************************************************/

'use strict';

// Encoding carrier caps ride the existing single sources: chunkHelper
// (protocol constants) + the compose-time limits in actions.js.
const { MAX_ACTION_DATA_LENGTH } = require('../chunkHelper.js');

// Per-carrier data budgets (bytes of action string). Mirrors
// actions.js ENCODING_LIMITS (OP_RETURN 80-4 magic; P2SH/P2WSH
// 520-44 script overhead per chunk; MULTISIGN 60/chunk).
const ENCODING_LIMITS = Object.freeze({
    OP_RETURN: 76,
    MULTISIGN: 60,
    P2SH:      476,
    P2WSH:     476,
});

// Report schema version (additive-only by convention). The report is
// consumed by the wallet PreflightPanel
// (packages/core/src/shared/components/PreflightPanel.jsx), which reads
// findings/severity/overridable/restricted/stateHeight/unverified and does
// NOT read schemaVersion: the additive-only rule has no enforcement point.
const REPORT_SCHEMA_VERSION = 1;

// Dispenser refill cap (indexer config.js MAX_REFILLS). A
// format-2 DISPENSER_EDIT that tops up GIVE_ESCROW is a refill, and the
// 6th is rejected once dispenser_caps_activation is live. The cap cannot
// be CHECKED client-side (no endpoint exposes per-edit give_escrow, see
// checks/dispenser.js), so this exists only to name the number in the
// unverified declaration. The authoritative value is config['MAX_REFILLS']
// in xchain-indexer/src/config.js, which src/actions/dispenser.js only READS
// by symbol, so that handler's mapped hash never moves when the cap does;
// checkConfigConstants in bin/check-preflight-drift.js is what catches a
// change to it, by value.
const MAX_REFILLS = 5;

// Canonical `^<id>` address-reference id, byte-for-byte the indexer's
// CANONICAL_CARET_ID (xchain-indexer src/db.js). Anything else - `^0`, `^007`,
// `^0x10`, `^abc`, a bare `^` - cannot resolve on ANY node, so at/after the
// caret-ref strict-activation flag-day it is a hard `invalid: <FIELD> (unresolvable ^id)` reject.
// The §8.5 drift gate over the mapped handlers is what catches a change to it.
const CANONICAL_CARET_ID = /^[1-9][0-9]*$/;

// Lifecycle constants (spec §4.6).
const DEFAULT_TIMEOUT_MS   = 4000;  // overall per-preflight budget
const RECHECK_TIMEOUT_MS   = 2000;  // Approve-time re-check budget
const STALENESS_MS         = 30000; // report age that forces a re-check
const ENDPOINT_MEMO_TTL_MS = 2000;  // per-endpoint response memo

/*
 * Finding-code registry (spec §4.2). One code per certified Tier-2
 * check plus the Tier-1 headlines and lifecycle notices. `checksRun`
 * uses these same identifiers; there is no separate check-ID
 * namespace.
 */
const FINDING_CODES = Object.freeze({
    // Tier-1 headlines
    DRYRUN_VALID:        'DRYRUN_VALID',
    DRYRUN_INVALID:      'DRYRUN_INVALID',
    DRYRUN_UNAVAILABLE:  'DRYRUN_UNAVAILABLE',
    // Certified Tier-2 (error-capable; §4.4 error column verbatim)
    PARSE_INVALID:       'PARSE_INVALID',
    VALIDATOR_SEMANTICS: 'VALIDATOR_SEMANTICS',
    DEST_ADDRESS_INVALID:'DEST_ADDRESS_INVALID',
    ENCODING_TOO_LARGE:  'ENCODING_TOO_LARGE',
    AMOUNT_FORMAT_INVALID:'AMOUNT_FORMAT_INVALID',
    BALANCE_INSUFFICIENT:'BALANCE_INSUFFICIENT',
    TOKEN_NOT_FOUND:     'TOKEN_NOT_FOUND',
    NOT_OWNER:           'NOT_OWNER',
    SUPPLY_EXCEEDED:     'SUPPLY_EXCEEDED',
    MINT_OVER_MAX:       'MINT_OVER_MAX',
    LIST_NOT_FOUND:      'LIST_NOT_FOUND',
    DISPENSER_NOT_FOUND: 'DISPENSER_NOT_FOUND',
    DISPENSER_NOT_OPEN:  'DISPENSER_NOT_OPEN',
    DISPENSER_TERMS_MISMATCH: 'DISPENSER_TERMS_MISMATCH',
    DISPENSER_EMPTY:     'DISPENSER_EMPTY',
    // Warnings / notices (never error)
    NATIVE_FEE_FORFEIT:  'NATIVE_FEE_FORFEIT',
    FEE_UNKNOWN:         'FEE_UNKNOWN',
    STALE_STATE:         'STALE_STATE',
    BATCH_NOT_ATOMIC:    'BATCH_NOT_ATOMIC',
    BATCH_LIMIT_EXCEEDED:'BATCH_LIMIT_EXCEEDED',
    TICK_FORMAT:         'TICK_FORMAT',
    AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
    EMPTY_NO_OP:         'EMPTY_NO_OP',
    METHOD_NOT_IN_MANIFEST: 'METHOD_NOT_IN_MANIFEST',
    EXPIRY_IN_PAST:      'EXPIRY_IN_PAST',
    DISPENSER_LIFECYCLE: 'DISPENSER_LIFECYCLE',
    DISPENSER_NOT_OWNER_W: 'DISPENSER_NOT_OWNER',
    GIVE_NOT_BALANCE_MODE: 'GIVE_NOT_BALANCE_MODE',
    DISPENSER_MAX_REFILLS: 'DISPENSER_MAX_REFILLS',
    // Warning-only, so deliberately absent from TIER2_ERROR_CAPABLE: the chain
    // gates this on the dispenser-family cohort and pre-flight has no height,
    // so an error would false-block a legal pre-activation edit (spec §4.2).
    DISPENSER_OWNERSHIP_ESCROW: 'DISPENSER_OWNERSHIP_ESCROW',
    CARET_REF_UNRESOLVABLE: 'CARET_REF_UNRESOLVABLE',
    // Declared-unverified only (never a finding): the oracle usage fee is
    // an OUTPUT-level rule, and pre-flight only ever sees an action string.
    DISPENSER_ORACLE_FEE: 'DISPENSER_ORACLE_FEE',
});

/*
 * The certified Tier-2 error-capable list (spec §4.4 legend): ONLY
 * these codes may carry severity 'error' from a client-side check.
 * Everything else Tier 2 produces caps at 'warning'. Locally-provable
 * subset additionally gets overridable:false; network-sourced entries
 * (marked here) are overridable:true.
 */
const TIER2_ERROR_CAPABLE = Object.freeze({
    // code -> 'local' (non-overridable) | 'network' (overridable)
    PARSE_INVALID:        'local',
    VALIDATOR_SEMANTICS:  'local',
    DEST_ADDRESS_INVALID: 'local',
    ENCODING_TOO_LARGE:   'local',
    AMOUNT_FORMAT_INVALID:'local',
    BALANCE_INSUFFICIENT: 'network',
    TOKEN_NOT_FOUND:      'network',
    NOT_OWNER:            'network',
    SUPPLY_EXCEEDED:      'network',
    MINT_OVER_MAX:        'network',
    LIST_NOT_FOUND:       'network',
    DISPENSER_NOT_FOUND:  'network',
    DISPENSER_NOT_OPEN:   'network',
    DISPENSER_TERMS_MISMATCH: 'network',
    DISPENSER_EMPTY:      'network',
});

// Tier-1 exclusions (spec §4.3): indexer FEE_QUOTE_DENYLIST mirror.
// Kept in lockstep with FEE_QUOTE_DENYLIST in xchain-indexer/src/actions.js, enforced by
// bin/check-preflight-drift.js (named, not line-pinned: the line pin had already drifted).
const TIER1_DENYLIST = Object.freeze(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);

// Fee-charging user actions (spec §4.4 "protocol-fee reality"). Membership mirrors
// the indexer handlers that call createFeesObject, plus the gas-priced VM pair
// (DEPLOY/EXECUTE). BET was missing for its whole life.
const FEE_CHARGING_ACTIONS = Object.freeze([
    'ISSUE', 'SWEEP', 'DISPENSER', 'DIVIDEND', 'AIRDROP', 'CALLBACK',
    'ORDER', 'SWAP', 'DEPLOY', 'EXECUTE', 'BET',
]);

module.exports = {
    REPORT_SCHEMA_VERSION,
    DEFAULT_TIMEOUT_MS,
    RECHECK_TIMEOUT_MS,
    STALENESS_MS,
    ENDPOINT_MEMO_TTL_MS,
    ENCODING_LIMITS,
    MAX_ACTION_DATA_LENGTH,
    MAX_REFILLS,
    CANONICAL_CARET_ID,
    FINDING_CODES,
    TIER2_ERROR_CAPABLE,
    TIER1_DENYLIST,
    FEE_CHARGING_ACTIONS,
};
