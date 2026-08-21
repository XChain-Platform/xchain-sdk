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
const Utility = require('../utility.js');

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
function isValidAmountFormat(decimals, amount) {
    return util.isValidAmountFormat(decimals, amount);
}

module.exports = { gte, gt, isPositive, add, sub, mulFloor, isValidAmountFormat };
