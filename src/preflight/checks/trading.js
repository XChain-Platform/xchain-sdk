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
 * Pre-flight Tier-2: ORDER + SWAP (spec §4.4; mirrors xchain-indexer
 * src/actions/order.js + swap.js:143-392). Balance-mode give checks
 * only: native-GIVE and GIVE_OWNERSHIP skip the balance check (info).
 * No self-trade / same-tick / min-max rules exist in the handlers -
 * do not invent them. SWAP lacks GET_AMOUNT>0 hardening, so ≤0
 * renders as warning there (ORDER-side it is also warning: the
 * handler check is server-side).
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');

async function checkGiveBalance(ctx, noun) {
    const version = String(ctx.parsed.version);
    if (version !== '0') {
        // v1 cancel / v2 edit: reference existence is warning-max
        // (event-stream reconstruction); keep it unverified for now.
        ctx.addUnverified(noun + '_REFERENCE', 'cancel/edit reference resolution is server-side');
        return;
    }
    const giveTick = ctx.field('GIVE_TICK');
    const giveAmount = ctx.field('GIVE_AMOUNT');
    const giveOwnership = ctx.field('GIVE_OWNERSHIP') === '1';
    const giveCoin = ctx.field('GIVE_COIN');
    const getAmount = ctx.field('GET_AMOUNT');
    const expiration = ctx.field('EXPIRATION');

    if (giveOwnership || (!giveTick && giveCoin)) {
        ctx.addFinding('GIVE_NOT_BALANCE_MODE', 'info',
            giveOwnership ? 'Ownership trade: no balance check applies.' : 'Native-coin give: settled by outputs, not balances.',
            {});
    } else if (giveTick && giveAmount && ctx.source) {
        const balance = await ctx.balance(ctx.source, giveTick);
        if (balance === null) {
            ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'balance lookup unavailable for ' + giveTick);
        } else {
            ctx.markRun(FINDING_CODES.BALANCE_INSUFFICIENT);
            if (!numeric.gte(balance, giveAmount)) {
                // §4.7 netting, same treatment as the SEND check.
                const inFlight = ctx.deltaApplied(giveTick);
                const netted = numeric.isPositive(inFlight);
                ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'error',
                    netted
                        ? `Balance of ${giveTick} (${balance} after ${inFlight} already committed from this wallet) `
                            + `does not cover the give amount (${giveAmount}).`
                        : `Balance of ${giveTick} (${balance}) does not cover the give amount (${giveAmount}).`,
                    { tick: giveTick, balance, giveAmount, ...(netted ? { localDeltaApplied: inFlight } : {}) });
            }
        }
    }

    if (getAmount !== '' && !numeric.isPositive(getAmount) && ctx.field('GET_OWNERSHIP') !== '1') {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'Get amount is not positive.', { getAmount });
    }
    if (expiration && /^\d+$/.test(expiration)) {
        ctx.addFinding(FINDING_CODES.EXPIRY_IN_PAST, 'info',
            'Expiration is checked against the chain tip at confirmation time.', { expiration });
    }
    ctx.addUnverified(noun + '_RESTRICTIONS',
        'allow/block lists and list-for-sale veto are server-side only');
}

async function checkOrder(ctx) { await checkGiveBalance(ctx, 'ORDER'); }
async function checkSwap(ctx)  { await checkGiveBalance(ctx, 'SWAP'); }

module.exports = { checkOrder, checkSwap };
