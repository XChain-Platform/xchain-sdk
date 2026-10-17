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
 * Pre-flight Tier-2: ISSUE amount formats and supply rules. Required by
 * checks/issue.js; mirrors xchain-indexer src/actions/issue/token_state.js and
 * supply_rules.js.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../../constants.js');
const numeric = require('../../numeric.js');
const { activeByWallClock } = require('../../activation.js');
const { tokenField } = require('../mint.js');
const { amountFormatOk, declareRepresentability, representabilityArmed } = require('../amount_format.js');

// Measure ISSUE's AMOUNT-class fields with the decimals consensus uses,
// so pre-flight cannot approve a spelling the chain will reject after fees.
//
// The static validator range-checks `split('.')[0]` and throws the fraction away, so
// MAX_SUPPLY=1.5 with DECIMALS=0 cleared the SDK and was then refused on-chain as
// 'invalid: MAX_SUPPLY (format)' with the miner fee already spent. The check belongs
// HERE rather than in the validator because the handler resolves tick_decimals from
// the TOKEN ROW first and falls back to the wire DECIMALS only when the row carries
// none (xchain-indexer src/actions/issue/token_state.js:75-76): on a re-issue the wire
// value is not the tick's decimals, so an offline reject keyed to it would block an
// action consensus accepts. Pre-flight is the one SDK layer that can read the row.
//
// Every field of the handler's fieldList['AMOUNT'] (issue/index.js:143) is judged here
// except CALLBACK_AMOUNT, which is measured against CALLBACK_TICK's own row (a second
// lookup) and is left to the server-side residue note.
const ISSUE_AMOUNT_FIELDS = ['MAX_SUPPLY', 'MAX_MINT', 'MINT_SUPPLY', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK'];

function checkMaxSupplyFormat(ctx, tick, token) {
    const present = ISSUE_AMOUNT_FIELDS.filter((f) => { const v = ctx.field(f); return v !== '' && !Array.isArray(v); });
    if (!present.length) return;

    const rowDecimals = token
        ? tokenField(token, ['supply.decimals', 'info.decimals', 'decimals', 'DECIMALS'])
        : null;
    const wireDecimals = ctx.field('DECIMALS');
    const decimals = rowDecimals !== null && rowDecimals !== undefined && rowDecimals !== ''
        ? rowDecimals
        : (wireDecimals === '' ? null : wireDecimals);

    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    declareRepresentability(ctx);
    // Neither side resolves a precision: consensus then judges with NaN decimals. The
    // legacy rule imposes no cap at all there, but the representability rule refuses
    // every amount (its decimals must parse), so the verdict turns on whether it is armed.
    if (decimals === null && representabilityArmed(ctx) !== true) return;
    for (const field of present) {
        const value = ctx.field(field);
        if (amountFormatOk(ctx, decimals, value)) continue;
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            `${field} ${value} is not a valid amount at ${decimals === null ? 'unresolved' : decimals} decimals for ${tick}; `
            + `the indexer rejects this ISSUE as invalid: ${field} (format).`,
            { tick, field, value, decimals, ...(field === 'MAX_SUPPLY' ? { maxSupply: value } : {}) });
        return;
    }
}

/*
 * The supply rules an ISSUE is refused by, from the token row and the wire
 * (xchain-indexer src/actions/issue/supply_rules.js):
 *   :41-42   a positive MAX_SUPPLY below the current SUPPLY       'MAX_SUPPLY < SUPPLY'
 *   :126-127 MINT_SUPPLY above MAX_SUPPLY                         'MINT_SUPPLY > MAX_SUPPLY'
 *   :140-145 SUPPLY + MINT_SUPPLY above MAX_SUPPLY, from the ISSUE_MINT_SUPPLY_CUMULATIVE_CAP
 *            activation (changes_3.js:94)                         'MINT_SUPPLY exceeds MAX_SUPPLY'
 * MAX_SUPPLY is the wire value, else the row's, as the handler's merge leaves it. The
 * MINT_SUPPLY rules are skipped on an uncapped token (MAX_SUPPLY 0): the handler exempts
 * it where UNCAPPED_MAX_SUPPLY_ZERO is enabled, and refusing there would be stricter than
 * the chain. SUPPLY is the explorer's current supply, so these are network-class findings.
 */
function checkSupplyRules(ctx, tick, token) {
    const wireMax = ctx.field('MAX_SUPPLY');
    const rowMax = token ? tokenField(token, ['supply.max', 'max_supply', 'MAX_SUPPLY', 'maxSupply']) : null;
    const maxSupply = wireMax !== '' && !Array.isArray(wireMax) ? wireMax : rowMax;
    const supply = token ? tokenField(token, ['supply.current', 'supply', 'SUPPLY', 'current_supply', 'total_supply']) : '0';
    const mintSupply = ctx.field('MINT_SUPPLY');
    ctx.markRun(FINDING_CODES.SUPPLY_EXCEEDED);
    const num = (v) => { try { numeric.gt(v, 0); return true; } catch (e) { return false; } };
    if (maxSupply === null || !num(maxSupply) || !numeric.isPositive(maxSupply)) return;
    if (supply !== null && num(supply) && wireMax !== '' && numeric.gt(supply, wireMax)) {
        ctx.addFinding(FINDING_CODES.SUPPLY_EXCEEDED, 'error',
            `MAX_SUPPLY ${wireMax} is below the current supply ${supply} of ${tick}; the indexer rejects this ISSUE `
            + 'as invalid: MAX_SUPPLY < SUPPLY.', { tick, maxSupply: wireMax, supply });
        return;
    }
    if (mintSupply === '' || Array.isArray(mintSupply) || !num(mintSupply)) return;
    if (numeric.gt(mintSupply, maxSupply)) {
        ctx.addFinding(FINDING_CODES.SUPPLY_EXCEEDED, 'error',
            `MINT_SUPPLY ${mintSupply} is above MAX_SUPPLY ${maxSupply} for ${tick}; the indexer rejects this ISSUE `
            + 'as invalid: MINT_SUPPLY > MAX_SUPPLY.', { tick, mintSupply, maxSupply });
        return;
    }
    if (!numeric.isPositive(mintSupply) || supply === null || !num(supply)) return;
    const cumulative = activeByWallClock('ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', ctx.sdk);
    const projected = numeric.add(supply, mintSupply);
    if (!numeric.gt(projected, maxSupply)) return;
    if (cumulative !== true) {
        ctx.addUnverified(FINDING_CODES.SUPPLY_EXCEEDED,
            'SUPPLY plus MINT_SUPPLY passes MAX_SUPPLY, which is refused from the cumulative-cap activation; '
            + 'this SDK\'s plane is unknown, so whether it is active cannot be read');
        return;
    }
    ctx.addFinding(FINDING_CODES.SUPPLY_EXCEEDED, 'error',
        `MINT_SUPPLY ${mintSupply} on top of the current supply ${supply} passes MAX_SUPPLY ${maxSupply} for ${tick}; `
        + 'the indexer rejects this ISSUE as invalid: MINT_SUPPLY exceeds MAX_SUPPLY.',
        { tick, mintSupply, supply, maxSupply, projected });
}

module.exports = { ISSUE_AMOUNT_FIELDS, checkMaxSupplyFormat, checkSupplyRules };
