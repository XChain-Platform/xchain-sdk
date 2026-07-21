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

async function checkDividend(ctx) {
    const amount = ctx.field('AMOUNT');
    if (amount && !numeric.isPositive(amount)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'Per-unit dividend amount is not positive.', { amount });
    }
    ctx.addUnverified('DIVIDEND_DEBIT_TOTAL',
        'the effective recipient set and total debit resolve server-side (Tier 1); zero holders is a valid no-op');
}

module.exports = { checkDividend };
