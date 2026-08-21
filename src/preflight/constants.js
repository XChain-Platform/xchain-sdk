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
// verdict/findings/restricted/stateHeight/unverified and never reads
// schemaVersion at runtime. The enforcement point is build-time on the
// wallet side: PreflightPanel exports SUPPORTED_SCHEMA_VERSION and
// test/unit/components/PreflightPanel.tier1Notice.test.jsx pins it to
// this constant, resolving the SDK the wallet INSTALLS. So a bump here
// fires that test when the wallet upgrades to the bumped SDK, not on the
// commit that changes this line; bump only alongside a review of every
// field the panel reads.
//
// `restricted` on the report means "covers a proper subset of the checks
// the action warrants", never a completeness claim either way: the full
// SDK preflight (index.js) always stamps false, and the wallet's dispenser
// buy panel (routes/DispenserDetail.jsx) authors a funding-only report with
// restricted: true that PreflightPanel renders as its "Partial check" chip.
// A new writer of the field inherits that meaning or picks a new name.
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
    // Tier-1 headlines for a PER-SUB-COMMAND verdict (BATCH only, see
    // TIER1_SUBCOMMAND_PREFLIGHT). The arbiter answers a batch at two levels and
    // the outer one is NOT a verdict on the inner ones: `valid:true` means the
    // transaction is accepted and its commands run, not that any of them succeed.
    // Measured on BTC regtest 2026-08-13: a batch whose ONLY sub-command is
    // `SEND|0|NOSUCHTOKENXYZ|1|<addr>` answers `valid:true, status:"valid"` with
    // `subCommands:[{status:"invalid: TICK (unknown)"}]`. Reporting only the outer
    // field would show a clean network PASS for a batch that does nothing.
    DRYRUN_SUBCOMMAND_INVALID:  'DRYRUN_SUBCOMMAND_INVALID',
    DRYRUN_SUBCOMMAND_UNJUDGED: 'DRYRUN_SUBCOMMAND_UNJUDGED',
    // Oracle usage fees the arbiter DISCLOSES rather than judges for a batch's
    // Mode B DISPENSER sub-commands (indexer actions/dispenser.js): a probe carries
    // no outputs, so it reports the total owed per oracle instead of a verdict.
    DRYRUN_ORACLE_FEES_OWED:    'DRYRUN_ORACLE_FEES_OWED',
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
    // No FEE_UNKNOWN code: the DEPLOY/EXECUTE protocol fee is disclosed
    // through the getFeeQuote / quoteNativeFee compose path, which the wallet
    // renders as NATIVE_FEE_UNVERIFIED_NOTICE, never through a pre-flight finding.
    // It was registered here with no producer anywhere in the SDK, wallet, or
    // indexer, which is exactly the second-list-with-no-owner this header forbids.
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

/*
 * Tier-1 exclusions (spec §4.3): indexer FEE_QUOTE_DENYLIST mirror.
 * Kept in lockstep with FEE_QUOTE_DENYLIST in xchain-indexer/src/actions.js, enforced by
 * bin/check-preflight-drift.js (named, not line-pinned: the line pin had already drifted).
 *
 * XEXEC IS DEFENCE-IN-DEPTH, AND DELIBERATELY UNREACHABLE
 *
 * Three of these four entries can actually be hit from `sdk.preflight()`; XEXEC
 * cannot, today, and that is not a defect. XEXEC is a cross-chain VM execution
 * the arbiter EMITS: it is mirror-injected from the hub mirror rather than
 * decoded off the wire (test/fixtures/action-manifest.json classifies it
 * `mirror-injected`, with no `wireDecoded` and no `userEncodable`). It therefore
 * has no entry in src/formats.js, so `decoder.parse('XEXEC|...')` returns
 * UNKNOWN_ACTION for every wire form and `runTier1` is never handed a parsed
 * action named XEXEC. A client composes EXECUTE; the chain, not the client,
 * produces the XEXEC leg on the far side.
 *
 * So the entry protects an input the SDK cannot currently manufacture. It stays
 * anyway, for two reasons:
 *
 *   1. This constant's job is to be byte-equal to the indexer literal it
 *      mirrors, which bin/check-preflight-drift.js binds BY VALUE. Dropping
 *      XEXEC because "the SDK can't reach it" would break the drift gate and
 *      silently unpin the mirror.
 *   2. `runTier1` short-circuits on the action NAME, not on provenance. The day
 *      XEXEC gains a wire format (or an internal caller hands Tier 1 a
 *      hand-built parsed action), this entry is the only thing standing between
 *      an unauthenticated caller and VM compute under the arbiter's block-loop
 *      mutex. A guard that only becomes load-bearing later must already be
 *      there, not added later by whoever adds the format.
 *
 * The reachability is pinned by test, not by this comment: the constants suite
 * asserts XEXEC is un-composable (no format, parse fails, manifest says
 * mirror-injected) and the Tier-1 suite drives the short-circuit with a
 * hand-built parsed action. If XEXEC ever becomes client-composable, the first
 * test fails on purpose, and the fix is to exercise this entry through the real
 * parse path rather than to delete either the entry or the test.
 */
const TIER1_DENYLIST = Object.freeze(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);

/*
 * Denylisted actions the indexer's /preflight endpoint nevertheless ANSWERS, per
 * sub-command, so Tier 1 must call it for them instead of short-circuiting.
 *
 * This exists because the two indexer probe surfaces stopped agreeing, and
 * TIER1_DENYLIST mirrors only one of them. `FEE_QUOTE_DENYLIST` is still the
 * literal it mirrors and BATCH is still on it - `computeFeeQuote` refuses a batch
 * for a reason this list does not touch, that a batch's native fee is the SUM of
 * its sub-actions' state-dependent fees and a partial quote UNDER-SIZES the output
 * and burns the payer's miner fee. `computePreflight` took a different door:
 * rather than lift BATCH out of the denylist (which would re-open the
 * unauthenticated VM-compute-under-mutex the denylist exists to close) it refuses
 * PER SUB-COMMAND and runs the rest, returning each one's own verdict.
 *
 * So this is NOT a hole in the mirror and must not be "fixed" by deleting BATCH
 * from TIER1_DENYLIST: that constant's job is to stay byte-equal to the indexer
 * literal, which bin/check-preflight-drift.js binds by VALUE, and the equality is
 * still true. What changed is a SECOND fact about a DIFFERENT surface, recorded
 * here in its own named place with its own reason.
 *
 * Adding an action here is a security decision, not a parity edit: it means Tier 1
 * will send that action to an unauthenticated read-only endpoint that runs the real
 * handler under the block-loop mutex. BATCH qualifies only because the arbiter
 * itself opened that door and enforces the VM refusal on its own side, twice
 * (a wire pre-scan before the mutex, and a check on the exact dispatched name).
 */
const TIER1_SUBCOMMAND_PREFLIGHT = Object.freeze(['BATCH']);

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
    TIER1_SUBCOMMAND_PREFLIGHT,
    FEE_CHARGING_ACTIONS,
};
