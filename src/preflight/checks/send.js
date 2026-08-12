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
 * Pre-flight Tier-2: SEND + DESTROY (spec §4.4 rows; mirrors
 * xchain-indexer src/actions/send.js:205-389 + destroy.js:164-227).
 *
 * Certified error-capable here: balance >= amount (per tick, legs
 * summed), token exists (universal covers it), amount format.
 * Warning-only: sleeping token, allow/block lists, controller-guard
 * outcome, gated-key handoff - all internal or Tier-1-only, so they
 * surface as unverified aspects. No fee on either action; no
 * self-send restriction and no amount floor exist in the handlers -
 * do not invent them (false-block invariant).
 *
 * The gated-key handoff became CONDITIONAL at the PC-29 flag-day:
 * a gated pack compels a MESSAGE only when the recipient's
 * POST-SEND balance reaches the pack's threshold (or the pack has no
 * threshold at all). That strictly narrows an existing rejection, and
 * deciding it needs the destination's pre-send balance snapshotted at
 * (BLOCK_INDEX, ACTION_INDEX) plus the tick's pack thresholds, neither
 * of which pre-flight can read - so it stays a declared-unverified
 * aspect, now named as conditional rather than blanket.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');

// Net multi-leg TICK/AMOUNT pairs into per-tick totals. SEND v1
// repeats AMOUNT under one TICK; v2/v3 repeat TICK too.
function perTickTotals(ctx) {
    const ticks = [].concat(ctx.params.TICK || []);
    const amounts = [].concat(ctx.params.AMOUNT || []);
    const totals = new Map();
    const n = Math.max(ticks.length, amounts.length);
    for (let i = 0; i < n; i++) {
        const tick = String(ticks[Math.min(i, ticks.length - 1)] || '');
        const amount = String(amounts[i] !== undefined ? amounts[i] : '');
        if (!tick || amount === '') continue;
        totals.set(tick, numeric.add(totals.get(tick) || '0', amount));
    }
    return totals;
}

async function checkBalanceCovers(ctx, verb) {
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'no source address supplied');
        return;
    }
    for (const [tick, total] of perTickTotals(ctx)) {
        if (!numeric.isPositive(total)) {
            ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
                `${verb} amount for ${tick} is not positive.`, { tick, total });
            continue;
        }
        const balance = await ctx.balance(ctx.source, tick);
        if (balance === null) {
            ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'balance lookup unavailable for ' + tick);
            continue;
        }
        ctx.markRun(FINDING_CODES.BALANCE_INSUFFICIENT);
        if (!numeric.gte(balance, total)) {
            // §4.7: say so when the shortfall comes from this wallet's own
            // in-flight spends - "you have 400" reads as a stale balance when
            // the chain still shows 1000, and the flag keeps the finding alive
            // through the dryrun-valid downgrade.
            const inFlight = ctx.deltaApplied(tick);
            const netted = numeric.isPositive(inFlight);
            ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'error',
                netted
                    ? `Balance of ${tick} (${balance} after ${inFlight} already committed from this wallet) `
                        + `does not cover the ${verb.toLowerCase()} total (${total}).`
                    : `Balance of ${tick} (${balance}) does not cover the ${verb.toLowerCase()} total (${total}).`,
                { tick, balance, total, ...(netted ? { localDeltaApplied: inFlight } : {}) });
        }
    }
}

async function checkSend(ctx) {
    await checkBalanceCovers(ctx, 'Send');
    ctx.addUnverified('SEND_RESTRICTIONS',
        'sleep state, allow/block lists, controller-guard outcome, and the conditional gated-key handoff '
        + '(required only when the recipient\'s post-send balance reaches a pack threshold) are server-side only');
}

async function checkDestroy(ctx) {
    await checkBalanceCovers(ctx, 'Destroy');
    ctx.addUnverified('DESTROY_RESTRICTIONS',
        'sleep state, allow/block lists, and burn-guard outcome are server-side only');
}

module.exports = { checkSend, checkDestroy, perTickTotals };
