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
 * XChain Platform SDK - pre-flight universal checks (spec §4.4 top table)
 *
 * Checks that apply to every action: validator semantic findings
 * (locally-provable; the delimiter/format subset hard-blocks),
 * encoding-fits-carrier, token existence for every referenced TICK,
 * the `^<id>` address-reference shape, and the native-fee forfeiture
 * notice for fee-charging actions.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, ENCODING_LIMITS, FEE_CHARGING_ACTIONS, CANONICAL_CARET_ID } = require('./constants.js');
const { ADDRESS_REF_FIELDS } = require('../addressRefFields.js');
const { TICK_EXISTENCE_FIELDS } = require('../tickRefFields.js');
const numeric = require('./numeric.js');

// Wire fields that reference a TICK whose existence is checkable.
// ISSUE is excluded at the loop below (existence is legal there: format 0
// creates). Derived from tickRefFields.js, never restated. FILE.GATE_TICKER
// belongs in this check: an unknown one makes the indexer reject the whole
// FILE, and a FILE carries its payload.
const TICK_FIELDS = TICK_EXISTENCE_FIELDS;

// Validator codes that are locally-provable, consensus-authoritative
// hard failures. Only FORBIDDEN_CHARACTER qualifies: a raw '|' or ';'
// in a non-exempt field corrupts the pipe layout and the indexer's
// positional parser is GUARANTEED to reject it. Every other validator
// code (including MISSING_REQUIRED_FIELD) can be stricter than
// consensus - the AIRDROP null-AMOUNT case (airdrop.js:176) is a
// required field the chain accepts - so it caps at warning. A
// non-overridable error the indexer would accept is a CI failure
// (spec §4.2 false-block invariant).
const HARD_VALIDATOR_CODES = new Set(['FORBIDDEN_CHARACTER']);

/*
 * The address fields whose handler RESOLVES a `^<id>` reference and states a
 * verdict on it (xchain-indexer db.resolveAddressRefChecked).
 *
 * Derived from the shared consensus map rather than listed again, because the
 * derivation is exact: every single-value, non-type-gated address field in
 * ADDRESS_REF_FIELDS has a resolveAddressRefChecked call site today, and the
 * two excluded shapes are excluded for reasons that also make them wrong to
 * flag here. SEND.DESTINATION is `multi` and send.js is the one address-bearing
 * handler with NO resolve call at all, so a `^id` there is rejected on format
 * in both eras; LIST.ITEM is `listType` and only holds an address when
 * the list TYPE says so, which pre-flight cannot decide from the wire alone.
 * `noCompact` fields (DISPENSER.GET_ADDRESS / ORACLE_ADDRESS) ARE included: the
 * SDK never emits them compacted, but the indexer still resolves a caller's.
 * They carry a second verdict of their own, below.
 */
const CARET_RESOLVED_FIELDS = (() => {
    const map = {};
    for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
        map[action] = ADDRESS_REF_FIELDS[action]
            .filter((spec) => !spec.multi && !spec.listType)
            .map((spec) => spec.field);
    }
    return map;
})();

/*
 * The `noCompact` subset of the above: fields the INDEXER resolves but the
 * DECODER cannot, per the consensus note in addressRefFields.js.
 *
 * Derived, never restated, so a field added to the map cannot miss this. The
 * verdict on these is decidable from the wire alone and does not depend on the
 * id being live: the decoder's address ids are a different sequence, so it
 * refuses the reference whatever it points at. A compacted DISPENSER.GET_ADDRESS
 * registers no dispenser at all, and a compacted ORACLE_ADDRESS means the
 * oracle-fee output is never captured, so the create is rejected after the fee
 * was spent. Pre-flight is the surface that says so: the validator stays silent
 * because the chain still ACCEPTS the transaction (spec §4.2 false-block
 * invariant), and the SDK's own compose path never emits one, so only a
 * hand-set param reaches here.
 */
const CARET_UNRESOLVABLE_BY_DECODER = (() => {
    const map = {};
    for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
        map[action] = new Set(ADDRESS_REF_FIELDS[action]
            .filter((spec) => spec.noCompact)
            .map((spec) => spec.field));
    }
    return map;
})();

/*
 * `^<id>` address references (caret-ref strict-activation flag-day).
 *
 * Two verdicts, and the split is the whole point. A NON-CANONICAL id can never
 * resolve on any node, so the client knows the outcome without asking anyone:
 * at/after the flag-day the handler rejects `invalid: <FIELD> (unresolvable
 * ^id)`, and below it the field falls through to the handler's own
 * isCryptoAddress check. A well-formed id that is simply DANGLING is the same
 * rejection with no local evidence: the explorer exposes address -> id
 * (/address/{addr}.info.address_id, which is how addressResolver.js compacts)
 * and nothing exposes the inverse, so the client cannot tell a live id from a
 * dead one and says so instead of guessing.
 *
 * Warning, never an error, even for the non-canonical case. Three call sites
 * had no follow-up format check before this activation (DISPENSER.ORACLE_ADDRESS on a
 * non-oracle dispenser, ISSUE.TRANSFER/TRANSFER_SUPPLY on the genesis path,
 * DEPLOY.SLASH_DESTINATION below its own flag-day), so those actions are still
 * ACCEPTED below the activation height on mainnet/testnet. A non-overridable
 * client error would false-block them (spec §4.2 false-block invariant), and
 * pre-flight has no chain height to gate on.
 */
function checkAddressRefs(ctx) {
    const fields = CARET_RESOLVED_FIELDS[ctx.parsed.action] || [];
    if (!fields.length) return;
    ctx.markRun(FINDING_CODES.CARET_REF_UNRESOLVABLE);
    for (const field of fields) {
        const value = ctx.params[field];
        if (value === undefined || value === null || Array.isArray(value)) continue;
        const str = String(value);
        if (str.charAt(0) !== '^') continue;
        if (!CANONICAL_CARET_ID.test(str.substring(1))) {
            ctx.addFinding(FINDING_CODES.CARET_REF_UNRESOLVABLE, 'warning',
                `${field} is the address reference ${str}, which is not a canonical ^<id> and can never resolve. `
                + 'The chain rejects it as an unresolvable reference.',
                { field, value: str });
            continue;
        }
        // Checked AFTER the canonical-shape branch, which is the stronger verdict
        // (that id resolves nowhere at all). A well-formed id on one of these
        // fields is still decidable, so it is reported rather than declared
        // unverified: only the DECODER's inability is at issue, not the id's.
        const decoderBlind = CARET_UNRESOLVABLE_BY_DECODER[ctx.parsed.action];
        if (decoderBlind && decoderBlind.has(field)) {
            ctx.addFinding(FINDING_CODES.CARET_REF_UNRESOLVABLE, 'warning',
                `${field} is the address reference ${str}, which the decoder cannot resolve: its address ids are `
                + 'a different sequence from the indexer\'s. Send the full address here. A compacted GET_ADDRESS '
                + 'registers no dispenser, and a compacted ORACLE_ADDRESS captures no oracle-fee output, so the '
                + 'create is rejected after the fee is spent.',
                { field, value: str });
            continue;
        }
        ctx.addUnverified(FINDING_CODES.CARET_REF_UNRESOLVABLE,
            'a well-formed ^<id> address reference cannot be resolved client-side: no endpoint maps an id back to its address');
    }
}

// D-9: the chain's NATIVE coin is not an XChain token, so it never appears in
// the token table and the token-existence check below would flag it as "does
// not exist" for any field that names it (a native-coin SEND, or a DEX order
// giving/getting the native coin). Chain coin codes are the native ticker with
// a network prefix (T=testnet, R=regtest, none=mainnet), e.g. RBTC/TBTC/BTC;
// strip it to recover the bare ticker a native reference uses. Returns null for
// non-native coin codes so nothing is skipped by accident.
function nativeTickerFromCoin(coin) {
    const m = /^[TR]?(BTC|LTC|DOGE)$/.exec(String(coin || '').toUpperCase());
    return m ? m[1] : null;
}

/*
 * Add `commandIndex` to a BATCH sub-command's validator finding.
 *
 * The parser already knows which command it is complaining about and says so as
 * `details.index` (with the raw `command` string beside it). Every OTHER
 * per-command finding names that same number `commandIndex`, because
 * CheckContext.addFinding stamps it from the child context checks/batch.js
 * builds - and these findings do not go through a child context, so they were
 * the one per-command shape carrying the number under a different key.
 *
 * That mattered once Tier 1 started answering a batch PER SUB-COMMAND: the
 * precedence rule in preflight/index.js reads `commandIndex` to decide whether
 * the network actually judged the command a finding is about, and an untagged
 * finding falls back to the whole-batch answer. The fallback is the SAFE
 * direction (it keeps the error unless every command was accepted), so this is
 * a sharpening, not a fix for a false pass: without it a local error on a
 * command the network ACCEPTED stayed an error because some OTHER command in
 * the batch failed, which is the false-block half of the same problem.
 *
 * `index` is kept as well as copied: it is part of the published finding data.
 * Returns the original object untouched for every non-BATCH finding, so nothing
 * outside a batch can be affected by this.
 */
function tagBatchCommand(parsed, details) {
    if (!details || parsed.action !== 'BATCH') return details;
    if (!Number.isInteger(details.index) || typeof details.command !== 'string') return details;
    if (details.commandIndex !== undefined) return details;
    return Object.assign({}, details, { commandIndex: details.index });
}

async function runUniversal(ctx, opts = {}) {
    const { parsed } = ctx;

    // 1. Parse/validator semantics (already parsed upstream; findings
    // ride along on the ParsedAction).
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    const vFindings = (parsed.validation && parsed.validation.findings) || [];
    for (const f of vFindings) {
        const details = tagBatchCommand(parsed, f.details);
        if (f.code === 'BATCH_LIMIT_EXCEEDED') {
            ctx.addFinding(FINDING_CODES.BATCH_LIMIT_EXCEEDED, 'warning', f.message, details);
            continue;
        }
        const isDest = f.details && f.details.field === 'DESTINATION';
        const isAmount = f.details && /AMOUNT|QUANTITY|SUPPLY|VALUE/.test(String(f.details.field || ''));
        if (isDest) {
            ctx.addFinding(FINDING_CODES.DEST_ADDRESS_INVALID, 'error', f.message, details);
        } else if (isAmount && f.code === 'INVALID_FIELD_VALUE') {
            ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error', f.message, details);
        } else if (HARD_VALIDATOR_CODES.has(f.code)) {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error', f.message, details);
        } else {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'warning', f.message, details);
        }
    }

    // 2. Encoding fits carrier (only when the caller told us the
    // intended encoding; compose-time _validateEncoding covers the
    // OP_RETURN path, this covers all carriers uniformly).
    ctx.markRun(FINDING_CODES.ENCODING_TOO_LARGE);
    if (opts.encoding) {
        const enc = String(opts.encoding).toUpperCase();
        const cap = ENCODING_LIMITS[enc];
        const bytes = Buffer.byteLength(parsed.actionString, 'utf8');
        if (cap && enc === 'OP_RETURN' && bytes > cap) {
            ctx.addFinding(FINDING_CODES.ENCODING_TOO_LARGE, 'error',
                `ACTION string is ${bytes} bytes but ${enc} carries at most ${cap}.`,
                { encoding: enc, bytes, cap });
        }
    }

    // 3. Token exists, per referenced TICK (network-sourced: a hostile
    // explorer could fabricate a 404, so the error is overridable).
    const nativeTicker = nativeTickerFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);
    for (const fieldName of TICK_FIELDS) {
        const v = ctx.params[fieldName];
        const ticks = Array.isArray(v) ? v : (v ? [v] : []);
        for (const tick of ticks) {
            if (!tick || parsed.action === 'ISSUE') continue;
            // D-9: the native coin is not a token; don't flag it as non-existent.
            if (nativeTicker && String(tick).trim().toUpperCase() === nativeTicker) continue;
            const token = await ctx.token(String(tick));
            if (token === null) {
                ctx.addFinding(FINDING_CODES.TOKEN_NOT_FOUND, 'error',
                    `Token ${tick} does not exist on this chain.`, { field: fieldName, tick });
            }
        }
    }

    // 4. `^<id>` address references (local; no network).
    checkAddressRefs(ctx);

    // 5. Native-fee forfeiture notice: fee-charging actions on chains
    // with mandatory native fees forfeit the native output if the
    // action is invalid. Always shown for fee-charging actions
    // (warning; the highest-cost failure mode, spec §4.2).
    if (FEE_CHARGING_ACTIONS.includes(parsed.action)) {
        ctx.addFinding(FINDING_CODES.NATIVE_FEE_FORFEIT, 'warning',
            'This action charges a protocol fee. If the chain rejects the action, any attached native-coin fee output is forfeited.',
            { action: parsed.action });
    }

    return ctx;
}

module.exports = { runUniversal, TICK_FIELDS, HARD_VALIDATOR_CODES, CARET_RESOLVED_FIELDS, numeric };
