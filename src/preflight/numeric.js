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
 * XChain Platform SDK - pre-flight numeric semantics (spec §4.5)
 *
 * Every Tier-2 comparison goes through arbitrary-precision decimal
 * (mathjs bignumber, the same engine the indexer uses); native JS
 * numbers WILL produce false verdicts past 2^53 or 16 significant
 * digits. Amount-format validity rides the already-parity-vendored
 * Utility.isValidAmountFormat (single in-repo source, cross-service
 * regression-guarded); this module must never reimplement it.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const Utility = require('../utils/utility.js');
const { AMOUNT_MAX_INTEGER_DIGITS } = require('./activation.js');

const util = new Utility();

function bn(v) { return util.bcnum(v); }

// EXACT comparisons via decimal.js's native .gt/.gte on the bignumber
// (mirrors xchain-indexer/src/utility.js:479-496). mathjs.larger /
// largerEq apply mathjs's epsilon tolerance (default 1e-12 relative),
// which would judge two amounts differing only in the 16th digit
// EQUAL - a false verdict on large balances. Never use them here.
function gte(a, b) { return bn(a).gte(bn(b)); }

function gt(a, b) { return bn(a).gt(bn(b)); }

function isPositive(v) { return bn(v).gt(bn(0)); }

// Whether an integer wire value is PROVABLY outside the unsigned range [0, max]
// the column storing it can hold. Byte-for-byte the indexer's
// exceedsUnsignedColumn (xchain-indexer/src/utility.js), including the part that
// looks like a defect and is not: it answers FALSE for anything it cannot prove
// (a spelling neither BigInt nor Number can read), so a value the chain accepts
// today keeps its current verdict and this can never be stricter than consensus.
//
// Plain integer literals compare as BigInt because Number() loses precision above
// 2^53: through a double, 18446744073709551616 equals the u64 ceiling and the
// first unstorable value would read as storable. `max` is therefore a decimal
// digit STRING (constants.js), never a number.
//
// The non-literal branch is the one that catches '1e30': isInteger accepts it
// (it IS an integer-valued double) and the digits regex does not, so the
// comparison falls through to the double, which is exact enough three orders of
// magnitude past the ceiling.
function exceedsUnsignedColumn(value, max) {
    if (value === null || value === undefined) return false;
    const raw = String(value).trim();
    if (/^[+-]?[0-9]+$/.test(raw)) {
        const n = BigInt(raw);
        return (n < 0n || n > BigInt(max));
    }
    const approx = Number(raw);
    return (Number.isFinite(approx) && (approx < 0 || approx > Number(max)));
}

function add(a, b) { return mathjs.format(mathjs.add(bn(a), bn(b)), { notation: 'fixed' }); }

function sub(a, b) { return mathjs.format(mathjs.subtract(bn(a), bn(b)), { notation: 'fixed' }); }

// Floor-not-round multiply for distributions (mirrors the indexer's
// bcmulfloor: distribution math always floors, spec §4.5.4).
//
// A fee is NOT a distribution. The arbiter bills gas with bcmul at 8 decimals,
// which rounds half-up, so a fee priced through this helper quotes one satoshi
// under the charge; price fees the way checks/batch.js does.
//
// The floor is decimal.js's native .floor() on the bignumber, exactly as
// xchain-indexer/src/utility.js bcmulfloor does it. mathjs.floor is FORBIDDEN
// here for the same reason mathjs.larger is forbidden above: it tests
// nearlyEqual against relTol (default 1e-12) first and returns the ROUNDED
// value when the scaled product sits just under the next integer, so it
// answered 138 for a product of 137.99999999999. That is exactly the sub-ULP
// band this family exists to get right, and it rounds UP, which a distribution
// must never do.
function mulFloor(a, b, decimals) {
    const d = Number.isInteger(decimals) ? decimals : 0;
    const product = mathjs.multiply(bn(a), bn(b));
    const scale = mathjs.bignumber(10).pow(d);
    const floored = bn(product).times(scale).floor().div(scale);
    return mathjs.format(floored, { notation: 'fixed' });
}

// Wire-amount format validity per the tick's decimals: the vendored
// consensus rule (negative, over-precision, non-numeric all refuse).
//
// THE TWO-ARGUMENT (LEGACY) RULE. The indexer's isValidAmountFormat takes an
// optional third argument, the including block's consensus timestamp, and a
// call that supplies it also applies the AMOUNT-REPRESENTABILITY rule below.
// src/utils/utility.js stays on the legacy rule because the indexer's
// 15-sdk-parity suite pins that two-argument behaviour; pre-flight applies the
// gate on top of it through isValidAmountFormatWhere.
function isValidAmountFormat(decimals, amount) {
    return util.isValidAmountFormat(decimals, amount);
}

// The indexer's PLAIN_DECIMAL: digits, optionally one '.' and at least one more
// digit (xchain-indexer src/utility/validation/amount_representability_gate.js).
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

// Byte-for-byte the indexer's isRepresentableAmount (same file): the amount text
// must be a plain unsigned decimal numeral whose significant integer digits fit
// AMOUNT_MAX_INTEGER_DIGITS and whose fraction fits the tick's decimals. Exponent
// notation, signs, radix prefixes, whitespace and empty halves all fail.
function isRepresentableAmount(decimals, text) {
    if (typeof text !== 'string') return false;
    if (!PLAIN_DECIMAL.test(text)) return false;
    const [int, sats] = text.split('.');
    if (int.replace(/^0+/, '').length > AMOUNT_MAX_INTEGER_DIGITS) return false;
    const d = parseInt(decimals, 10);
    if (!Number.isFinite(d)) return false;
    if (sats !== undefined && sats.length > d) return false;
    return true;
}

// The indexer's three-argument isValidAmountFormat (amount_validation.js): where the
// representability rule is armed it is an extra early refusal ahead of the legacy body,
// so it can only refuse more. `armed` is the caller's reading of the activation table
// (checks/amount_format.js); anything but true keeps the legacy verdict.
function isValidAmountFormatWhere(decimals, amount, armed) {
    if (armed === true && !isRepresentableAmount(decimals, amount === null || amount === undefined ? null : String(amount)))
        return false;
    return util.isValidAmountFormat(decimals, amount);
}

module.exports = {
    gte, gt, isPositive, add, sub, mulFloor, isValidAmountFormat, isRepresentableAmount, isValidAmountFormatWhere,
    exceedsUnsignedColumn,
};
