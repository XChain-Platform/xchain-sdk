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
 * Pre-flight Tier-2: ISSUE (spec §4.4; mirrors xchain-indexer
 * src/actions/issue.js). THE load-bearing correction from the
 * ground-truthing pass: existence alone is NOT a reject (format 0 is
 * create-or-edit); the reject is existence AND caller is not the
 * owner. Fee only on create (issue.js:531). Lock ratchets,
 * isDistributed callback freeze, and TICK reserved tables are
 * internal; TICK charset mirrors as warning only.
 *
 * Two lock-side movements since, both server-side and both already
 * inside the ISSUE_LOCK_RATCHETS declaration: LOCK_NULL_PRIOR_UNSET
 *  makes an absent prior read as UNSET rather than locked,
 * which strictly narrows the "(locked)" rejection, and it is resolved
 * once per action so the gate cannot differ field to field. The
 * TRANSFER / TRANSFER_SUPPLY `^<id>` rejection added at the 
 * flag-day is covered by the universal address-ref check, which is
 * where it belongs: it is the same rule on five other actions, and
 * ISSUE's genesis path skips the isCryptoAddress checks that used to
 * be the only thing catching it.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { tokenField } = require('./mint.js');

// MAX_SUPPLY fractional precision, measured at the decimals CONSENSUS uses (#4314).
//
// The static validator range-checks `split('.')[0]` and throws the fraction away, so
// MAX_SUPPLY=1.5 with DECIMALS=0 cleared the SDK and was then refused on-chain as
// 'invalid: MAX_SUPPLY (format)' with the miner fee already spent. The check belongs
// HERE rather than in the validator because issue.js:258 resolves tick_decimals from
// the TOKEN ROW first and falls back to the wire DECIMALS only when the row carries
// none: on a re-issue the wire value is not the tick's decimals, so an offline reject
// keyed to it would block an action consensus accepts (an 8-decimal token re-issued
// with a stale DECIMALS=0 and MAX_SUPPLY=1000.5 is legal on-chain). Pre-flight is the
// one SDK layer that can read the row, so it is the one that can ask the question.
//
// Only MAX_SUPPLY: it is the AMOUNT-family field carried by ISSUE v0, the format that
// also carries DECIMALS. CALLBACK_AMOUNT is measured against CALLBACK_TICK's own row
// (a second lookup) and is left to the server-side residue note.
function checkMaxSupplyFormat(ctx, tick, token) {
    const value = ctx.field('MAX_SUPPLY');
    if (!value || Array.isArray(value)) return;

    const rowDecimals = token
        ? tokenField(token, ['supply.decimals', 'info.decimals', 'decimals', 'DECIMALS'])
        : null;
    const wireDecimals = ctx.field('DECIMALS');
    const decimals = rowDecimals !== null && rowDecimals !== undefined && rowDecimals !== ''
        ? rowDecimals
        : (wireDecimals === '' ? null : wireDecimals);

    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    // Neither side resolves a precision: that is consensus's own NaN-decimals case, which
    // imposes no cap at all, so asserting one here would be stricter than the chain.
    if (decimals === null) return;
    if (!numeric.isValidAmountFormat(decimals, value)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            `MAX_SUPPLY ${value} is not a valid amount at ${decimals} decimals for ${tick}.`,
            { tick, maxSupply: value, decimals });
    }
}

async function checkIssue(ctx) {
    const tick = ctx.field('TICK');
    if (!tick || Array.isArray(tick)) return;

    const token = await ctx.token(tick);
    ctx.markRun(FINDING_CODES.NOT_OWNER);
    if (token === undefined) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'token lookup unavailable');
        // The MAX_SUPPLY precision check is skipped with it: without the row there is no
        // way to tell a create's authoritative DECIMALS from a re-issue's stale one.
        ctx.addUnverified(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'token lookup unavailable');
        return;
    }
    checkMaxSupplyFormat(ctx, tick, token);
    if (token === null) return; // fresh create: nothing further to gate

    const owner = tokenField(token, ['info.owner', 'owner', 'OWNER', 'owner_address', 'issuer']);
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'no source address supplied');
    } else if (owner && owner !== ctx.source) {
        ctx.addFinding(FINDING_CODES.NOT_OWNER, 'error',
            `${tick} exists and is owned by ${owner}; only the owner can edit it.`,
            { tick, owner, source: ctx.source });
    }

    ctx.addUnverified('ISSUE_LOCK_RATCHETS',
        'lock ratchets vs requested edits, isDistributed callback freeze, and reserved-TICK tables are server-side only');
}

module.exports = { checkIssue };
