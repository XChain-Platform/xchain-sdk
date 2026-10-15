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
 * Pre-flight Tier-2 amount-format verdicts shared by every checks module
 * that judges an amount against a tick's decimals.
 *
 * The indexer validates an amount with isValidAmountFormat(decimals, amount,
 * BLOCK_TIME) (xchain-indexer src/utility/validation/amount_validation.js), which
 * applies the AMOUNT-REPRESENTABILITY rule ahead of the legacy text rule wherever
 * amount_representability_activation is armed (src/protocol_changes/gates_1.js:
 * BTC, LTC and DOGE testnet at time 1791061097, regtest from genesis, mainnet and
 * the bare testnet row unarmed). Pre-flight reads the same table
 * (ACTIVATION_MIRRORS.AMOUNT_REPRESENTABILITY, bound by value by the drift gate)
 * and applies the rule where it is armed. Where it is not, or where this SDK's
 * plane is unknown, the legacy verdict stands and the rule is declared unverified.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, activeByWallClock, describeActivationHere } = require('../constants.js');
const numeric = require('../numeric.js');

// true where the representability rule binds the next block, false where it does
// not, undefined when this SDK's plane is unknown.
function representabilityArmed(ctx) {
    return activeByWallClock('AMOUNT_REPRESENTABILITY', ctx.sdk);
}

// The indexer's verdict on `amount` at `decimals` for a block confirmed now.
function amountFormatOk(ctx, decimals, amount) {
    return numeric.isValidAmountFormatWhere(decimals, amount, representabilityArmed(ctx) === true);
}

// Declare the rule wherever it is not applied, naming where it stands on this plane.
function declareRepresentability(ctx) {
    if (representabilityArmed(ctx) === true) return;
    ctx.addUnverified('AMOUNT_REPRESENTABILITY',
        'above its flag-day an amount must be a plain decimal numeral denoting the number the ledger credits, '
        + 'so exponent notation, a sign, a radix prefix and an integer too wide for the ledger aggregation are '
        + 'rejected; ' + describeActivationHere('AMOUNT_REPRESENTABILITY', ctx.sdk));
}

// A token row's decimals, or null when the row does not carry them.
// Read in the order checks/mint.js tokenField reads them, nested shape first.
function tokenDecimals(token) {
    if (!token || typeof token !== 'object') return null;
    const candidates = [token.supply && token.supply.decimals, token.info && token.info.decimals,
        token.decimals, token.DECIMALS];
    for (const d of candidates) {
        if (d === undefined || d === null || d === '' || typeof d === 'object') continue;
        return String(d);
    }
    return null;
}

// Raise AMOUNT_FORMAT_INVALID when `amount` fails the indexer's rule at `decimals`.
// Returns true when it raised. `label` names the field in the message and data.
function checkAmountField(ctx, label, amount, decimals, extra) {
    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    if (amount === '' || amount === null || amount === undefined || Array.isArray(amount)) return false;
    if (decimals === null || decimals === undefined) return false;
    if (amountFormatOk(ctx, decimals, amount)) return false;
    // The validator may already have refused the same field's text (universal.js).
    if (ctx.findings.some((f) => f.code === FINDING_CODES.AMOUNT_FORMAT_INVALID && f.severity === 'error'
        && f.data && f.data.field === label && (ctx.commandIndex === null || f.data.commandIndex === ctx.commandIndex)))
        return false;
    ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
        `${label} ${amount} is not a valid amount at ${decimals} decimals; the indexer rejects this action as `
        + `invalid: ${label} (format).`,
        Object.assign({ field: label, amount: String(amount), decimals: String(decimals) }, extra || {}));
    return true;
}

module.exports = { representabilityArmed, amountFormatOk, declareRepresentability, tokenDecimals, checkAmountField };
