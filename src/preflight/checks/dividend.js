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
 * Pre-flight Tier-2: DIVIDEND (spec §4.4). The authoritative debit
 * (dividend-tick balance vs per-unit x effective holder units) is
 * Tier-1 territory; the client estimate stays a warning. Zero holders
 * is a VALID no-op. Units count in TICK decimals, amounts pay in
 * DIVIDEND_TICK decimals (§4.5.5) - the estimate must not mix them.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { declareRepresentability, tokenDecimals, checkAmountField } = require('./amount_format.js');

// AMOUNT is required and judged against DIVIDEND_TICK's decimals, the paying token
// (xchain-indexer src/actions/dividend/validate.js:41-43): an empty AMOUNT is refused
// as AMOUNT (format) too. A DIVIDEND_TICK that does not exist is left to TOKEN_NOT_FOUND.
async function checkDividendAmountFormat(ctx) {
    const amount = ctx.field('AMOUNT');
    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    if (amount === '') {
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            'AMOUNT is empty; the indexer rejects a DIVIDEND without a per-unit amount as invalid: AMOUNT (format).',
            { field: 'AMOUNT', amount: '' });
        return;
    }
    const divTick = ctx.field('DIVIDEND_TICK');
    if (!divTick || Array.isArray(amount)) return;
    const token = await ctx.token(divTick);
    if (token === undefined) { ctx.addUnverified(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'token lookup unavailable for ' + divTick); return; }
    checkAmountField(ctx, 'AMOUNT', amount, tokenDecimals(token), { tick: divTick });
}

async function checkDividend(ctx) {
    await checkDividendAmountFormat(ctx);
    declareRepresentability(ctx);
    const amount = ctx.field('AMOUNT');
    if (amount && !numeric.isPositive(amount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'Per-unit dividend amount is not positive.', { amount });
    }
    ctx.addUnverified('DIVIDEND_DEBIT_TOTAL',
        'the effective recipient set and total debit resolve server-side (Tier 1); zero holders is a valid no-op');
}

module.exports = { checkDividend };
