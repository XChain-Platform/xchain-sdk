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
 * and the native-fee forfeiture notice for fee-charging actions.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, ENCODING_LIMITS, FEE_CHARGING_ACTIONS } = require('./constants.js');
const numeric = require('./numeric.js');

// Wire fields that reference a TICK whose existence is checkable.
// ISSUE is excluded (existence is legal there: format 0 creates).
const TICK_FIELDS = ['TICK', 'DIVIDEND_TICK', 'GIVE_TICK', 'GET_TICK', 'CALLBACK_TICK'];

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

async function runUniversal(ctx, opts = {}) {
    const { parsed } = ctx;

    // 1. Parse/validator semantics (already parsed upstream; findings
    // ride along on the ParsedAction).
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    const vFindings = (parsed.validation && parsed.validation.findings) || [];
    for (const f of vFindings) {
        if (f.code === 'BATCH_LIMIT_EXCEEDED') {
            ctx.addFinding(FINDING_CODES.BATCH_LIMIT_EXCEEDED, 'warning', f.message, f.details);
            continue;
        }
        const isDest = f.details && f.details.field === 'DESTINATION';
        const isAmount = f.details && /AMOUNT|QUANTITY|SUPPLY|VALUE/.test(String(f.details.field || ''));
        if (isDest) {
            ctx.addFinding(FINDING_CODES.DEST_ADDRESS_INVALID, 'error', f.message, f.details);
        } else if (isAmount && f.code === 'INVALID_FIELD_VALUE') {
            ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error', f.message, f.details);
        } else if (HARD_VALIDATOR_CODES.has(f.code)) {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error', f.message, f.details);
        } else {
            ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'warning', f.message, f.details);
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

    // 4. Native-fee forfeiture notice: fee-charging actions on chains
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

module.exports = { runUniversal, TICK_FIELDS, HARD_VALIDATOR_CODES, numeric };
