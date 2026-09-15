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
 * Pre-flight Tier-2 DISPENSER amount rules: the activation-gated GIVE_AMOUNT
 * and GET_AMOUNT checks on a create, the amount-representability declaration,
 * and the stored-price check on a DISPENSE. Required by checks/dispenser.js;
 * mirrors xchain-indexer src/actions/dispenser.js and src/actions/dispense.js.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../../constants.js');
const numeric = require('../../numeric.js');
const { getCoinConfig } = require('../../../coins/index.js');

// Decimal places of the chain coin a GET_COIN names, read from the vendored coin
// registry so the precision rule below cannot drift from the indexer's
// COIN_DECIMALS. Null for anything that is not a native coin code.
function nativeCoinDecimals(coin) {
    const m = /^[TR]?(BTC|LTC|DOGE)$/.exec(String(coin || '').toUpperCase());
    if (!m) return null;
    try { return getCoinConfig(m[1], 'mainnet').decimals; } catch (e) { return null; }
}

// Strictly-positive test that answers false, never throws, on a value the
// bignumber parser rejects: the indexer's own positivity rule reads a
// non-numeric string as "not greater than zero" too.
function isStrictlyPositive(v) {
    try { return numeric.isPositive(v); } catch (e) { return false; }
}

// A dispenser prices itself when it names neither a FIAT_CODE nor an
// ORACLE_ADDRESS; only then is GET_AMOUNT the price and subject to the
// amount-positivity rules.
function isSelfPriced(fiatCode, oracleAddress) {
    return !fiatCode && !oracleAddress;
}

// A balance dispenser must hand out something. Mirrors the Format-0
// create rule in xchain-indexer/src/actions/dispenser.js: an absent or
// non-positive GIVE_AMOUNT with GIVE_OWNERSHIP=0 opens a dispenser that
// settles buyer payments as VALID fills crediting nothing, because every
// downstream guard reads a non-positive GIVE_AMOUNT as "ownership
// dispenser" and skips, while the auto-close threshold is that same
// non-positive value, so it never closes and keeps absorbing payments.
//
// Warning rather than error, and deliberately so: the handler gates the
// rejection behind dispenser_give_amount_activation, and preflight runs at
// AUTHORING time with no block time to test the flag-day against. Below
// the activation the chain still accepts this create, so calling it an
// error would refuse a transaction the network takes. Above it, the
// warning is the only notice a client gets before spending the fee. Same
// treatment, and the same reasoning, as the `^id` caret-ref activation.
function checkGiveAmount(ctx) {
    const giveAmount = ctx.field('GIVE_AMOUNT');
    if (!giveAmount || !numeric.isPositive(giveAmount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'GIVE_AMOUNT is required and must be greater than 0 for a balance dispenser '
                + '(GIVE_OWNERSHIP=0); at or above the activation the indexer rejects this create, '
                + 'and below it the dispenser opens but credits nothing while absorbing payments.',
            { giveAmount: giveAmount ?? null, giveOwnership: '0' });
    }
}

// A dispenser that names its own price must name a positive, well-formed
// one. Mirrors the two Format-0 rules xchain-indexer/src/actions/dispenser.js
// enforces behind dispenser_amount_positivity_activation: a native-coin-priced
// GET_AMOUNT (empty GET_TICK) is checked against COIN_DECIMALS, which the
// token-priced path always did and this path never had, and a GET_AMOUNT on
// a dispenser with neither FIAT_CODE nor ORACLE_ADDRESS must be strictly
// positive (the ORDER-AMT-1 shape). A negative price that reaches storage
// settles dust payments as valid fills and manufactures escrow on close.
//
// Warning rather than error, for exactly the GIVE_AMOUNT reasoning above:
// the handler gates both on the block's consensus time and pre-flight has
// no block time, so it cannot certify which side of the flag-day this
// create lands on. The 2026-09-09 ruling armed the gate at genesis on
// every network (dispenser_amount_positivity_activation reads `mainnet: 0`),
// so the unarmed-mainnet half of this reasoning no longer applies.
function checkSelfPrice(ctx) {
    const getAmount = ctx.field('GET_AMOUNT');
    if (isSelfPriced(ctx.field('FIAT_CODE'), ctx.field('ORACLE_ADDRESS'))) {
        const decimals = ctx.field('GET_TICK') ? null : nativeCoinDecimals(ctx.field('GET_COIN'));
        if (getAmount && decimals !== null && !numeric.isValidAmountFormat(decimals, getAmount)) {
            ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'warning',
                `GET_AMOUNT (${getAmount}) is not a valid ${ctx.field('GET_COIN')} amount at ${decimals} decimals; `
                    + 'at or above the activation the indexer rejects this create.',
                { getAmount, getCoin: ctx.field('GET_COIN'), decimals });
        } else if (!getAmount || !isStrictlyPositive(getAmount)) {
            ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
                'GET_AMOUNT is required and must be greater than 0 on a dispenser that names its own price '
                    + '(no FIAT_CODE, no ORACLE_ADDRESS); at or above the activation the indexer rejects this create, '
                    + 'and below it a non-positive price settles dust payments as valid fills.',
                { getAmount: getAmount ?? null });
        }
    }
}

// GIVE_AMOUNT, GIVE_ESCROW, GET_AMOUNT and FIAT_AMOUNT are all judged above (or
// by validator.js) against the LEGACY amount-format rule, see numeric.js. Above
// its flag-day the indexer also requires each of them to denote the number the
// ledger credits, which pre-flight cannot decide: it needs the activation state
// of the block that will carry the create. Declared rather than raised, because
// neither mainnet nor testnet is armed and rejecting here would block a create
// both planes accept.
function declareAmountRepresentability(ctx) {
    ctx.addUnverified('AMOUNT_REPRESENTABILITY',
        'above its flag-day every amount on this create must be a plain decimal numeral denoting the '
        + 'number the ledger credits, so exponent notation and an integer too wide for the ledger '
        + 'aggregation are rejected instead of crediting a different number; the activation state of '
        + 'the including block is server-side only, and neither mainnet nor testnet is armed for it');
}

// The settlement half of dispenser_amount_positivity_activation
// (xchain-indexer src/actions/dispense.js): the fill count must be strictly
// positive, not merely non-zero, and a GET_AMOUNT the divide cannot parse is
// rejected at the divide. Against a SELF-PRICED dispenser the count is
// floor(payment / GET_AMOUNT), so a stored price that is non-numeric or not
// positive fails every dispense, whatever the payment. The FIAT and oracle
// paths price from elsewhere and are not predictable here.
//
// Warning, not error: the count rule is time-gated and pre-flight has no block
// time, while a create that stored such a price predates the activation by
// construction.
function checkDispensePrice(ctx, idx, dispenser) {
    const getAmount = dispenser.get_amount ?? dispenser.GET_AMOUNT;
    const selfPriced = isSelfPriced(dispenser.fiat_code ?? dispenser.FIAT_CODE,
        dispenser.oracle_address ?? dispenser.ORACLE_ADDRESS);
    if (selfPriced && getAmount !== undefined && getAmount !== null && String(getAmount) !== ''
        && !isStrictlyPositive(String(getAmount))) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            `Dispenser #${idx} prices at GET_AMOUNT ${getAmount}, which is not a positive amount; `
                + 'at or above the activation every dispense against it is rejected at settlement, '
                + 'AFTER your native coin moves.',
            { dispenserActionIndex: idx, getAmount: String(getAmount) });
    }
}

module.exports = { checkGiveAmount, checkSelfPrice, declareAmountRepresentability, checkDispensePrice };
