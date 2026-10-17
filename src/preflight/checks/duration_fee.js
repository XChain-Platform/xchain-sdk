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
 * Pre-flight Tier-2: the duration fee of a lone ORDER, SWAP or DISPENSER
 * create, checked against the source's gas-token balance.
 *
 * The indexer prices a format-0 create from its own EXPIRATION
 * (getUnifiedExpirationFee, xchain-indexer src/utility/fees.js:286-300) and,
 * when the fee is debited rather than paid as a native output, refuses the
 * create as `invalid: insufficient funds (FEE)` (src/actions/order/fees.js:77-78,
 * src/actions/swap/fees.js and src/actions/dispenser/fees.js the same way).
 * checks/batch.js already prices this per sub-command; this is the same
 * projection for the action on its own.
 *
 * The chain counts days from the including block's time, which is after now, and
 * the fee shrinks as that time advances. So the error is judged on the fee one
 * day later than now (a lower bound for any block confirmed within a day), and a
 * balance between that and the fee at now is a warning. The ownership-escrow
 * premium a GIVE_OWNERSHIP create adds is left out, which keeps the figure a
 * lower bound. An edit (format 2) is priced against the stored expiration, which
 * pre-flight does not read, so it is declared instead.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { GAS_TICK } = require('../../protocol/constants.js');
const { gasConfig, xchainFeeDebit, projectDurationFee } = require('./batch/fee_projection.js');

const DAY_MS = 86400 * 1000;

// The duration fee for this create with the clock at `nowMs`, or null when it cannot be priced.
function feeAt(ctx, gas, nowMs) {
    return projectDurationFee({ version: ctx.parsed.version, params: ctx.params }, gas, nowMs);
}

async function checkDurationFee(ctx) {
    // Inside a BATCH the batch fee budget (checks/batch.js) owns every sub-command's fee.
    if (ctx.commandIndex !== null && ctx.commandIndex !== undefined) return;
    const version = String(ctx.parsed.version);
    if (version === '2' && ctx.field('EXPIRATION') !== '') {
        ctx.addUnverified('DURATION_FEE',
            'an edit that extends EXPIRATION is charged for the added days against the stored expiration, '
            + 'which pre-flight does not read');
        return;
    }
    if (version !== '0' || ctx.field('EXPIRATION') === '') return;
    const gas = gasConfig(ctx.sdk);
    if (!gas) {
        ctx.addUnverified('DURATION_FEE', 'no gas schedule resolves for this SDK\'s network');
        return;
    }
    if (!xchainFeeDebit(ctx, gas)) return;
    const now = Date.now();
    const upper = feeAt(ctx, gas, now);
    const lower = feeAt(ctx, gas, now + DAY_MS);
    if (!upper || !numeric.isPositive(upper.amount)) return;
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'no source address supplied');
        return;
    }
    const balance = await ctx.balance(ctx.source, GAS_TICK);
    if (balance === null) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'balance lookup unavailable for ' + GAS_TICK);
        return;
    }
    ctx.markRun(FINDING_CODES.BALANCE_INSUFFICIENT);
    if (numeric.gte(balance, upper.amount)) return;
    const certain = lower && numeric.isPositive(lower.amount) && !numeric.gte(balance, lower.amount);
    ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, certain ? 'error' : 'warning',
        `Balance of ${GAS_TICK} (${balance}) does not cover the ${upper.amount} expiration fee this `
        + `${ctx.parsed.action} is charged for its EXPIRATION; the indexer rejects it as insufficient funds (FEE).`,
        { tick: GAS_TICK, balance, fee: upper.amount, feeLowerBound: lower ? lower.amount : null });
}

module.exports = { checkDurationFee };
