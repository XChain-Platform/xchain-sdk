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
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../../constants.js');
const numeric = require('../../numeric.js');
const coins = require('../../../coins');
const { GAS_TICK } = require('../../../protocol/constants.js');
const { CHILD_ISSUE_KEY, classifyIssueTick } = require('../../../protocol/batch_limits.js');
const Utility = require('../../../utils/utility.js');

// The vendored consensus arithmetic (bcsub/bcdiv/bcmul with the arbiter's
// fixed-precision rounding). The duration-fee day count MUST round to nearest,
// exactly as the chain's does; ../numeric.js deliberately exposes no rounding
// division, so the fee math below reads the same helpers the arbiter reads.
const util = new Utility();

// Price gas the way the arbiter CHARGES it: bcmul at 8 decimals, whose
// fixed-precision format rounds half-up (xchain-indexer/src/utility.js
// getUnifiedTransactionFee / getOwnershipEscrowFee / the expiration-fee paths
// all bill through it). numeric.mulFloor is the DISTRIBUTION rule and floors, so
// pricing a fee with it under-quoted the charge by 1e-8 wherever the product
// carried a nonzero 9th decimal - the preview and the handler disagreeing on a
// balance verdict. Nothing moves at the shipped GAS_PRICE of '0.00001' against
// integer gas units, where every product is exact by the 5th decimal; the point
// is that a future price change cannot fork the two silently.
//
// Re-normalized to minimal form because the amount is not an internal number:
// it is read straight into the BALANCE_INSUFFICIENT copy and its cheapest/total
// data, and bcmul's zero-padded '0.50000000' where '0.5' stands today would be a
// shape change dressed as a rounding fix. It also keeps the quote byte-equal to
// the indexer's own fee value, which stringifies minimally off its bignumber.
const gasFee = (units, gasPrice) => numeric.add(util.bcmul(units, gasPrice, 8), '0');

// Sub-commands whose creation fee is duration-metered off the wire's own
// EXPIRATION (format 0 only). Matches the arbiter's durationFeeActions.
const DURATION_FEE_ACTIONS = ['ORDER', 'SWAP', 'DISPENSER'];

/*
 * The gas schedule this chain prices an issuance from
 * (xchain-indexer/src/actions/issue.js: GAS_SCHEDULE.ISSUE for a top-level
 * tick, ISSUE_SUBTOKEN for a child, times GAS_PRICE). Read from the canonical
 * coin registry rather than restated, so the §8.5 drift gate's GAS_SCHEDULE
 * comparison covers this projection too. Returns null when the SDK's network
 * string names no coin we can price from - the caller then declares the fee
 * unverified instead of guessing a number.
 */
function gasConfig(sdk) {
    try {
        const [fullName, network] = String((sdk && sdk.config && sdk.config.network) || '').split('-');
        const tick = coins.FULL_NAME_TO_TICK[fullName];
        if (!tick || !coins.NETWORKS.includes(network)) return null;
        const cfg = coins.getCoinConfig(tick, network);
        if (!cfg || !cfg.GAS_SCHEDULE || !cfg.GAS_PRICE) return null;
        return {
            coin: tick,
            gasPrice: cfg.GAS_PRICE,
            schedule: cfg.GAS_SCHEDULE,
            freeDays: cfg.UNIFIED_EXPIRATION_FEE_FREE_DAYS || 90,
        };
    } catch (e) {
        return null;
    }
}

/*
 * Whether the issuance fee is settled by DEBITING the source's gas-token
 * balance, which is the only mode a client can check a balance against.
 *
 * The chain's own rule (indexer utility.js detectFeePaymentMode): a fee OUTPUT
 * makes it native; with no output, BTC falls back to the XCHAIN debit and
 * LTC/DOGE reject outright. A caller who stated feeMode is believed. Where
 * nothing is stated and the coin is LTC/DOGE the fee is a coin output, so a
 * balance error would false-block exactly the payer the native mode exists for
 * (spec §4.2). An unresolvable coin keeps the check: the finding is
 * network-class and therefore overridable, and silence there would hide the
 * shortfall this projection exists to surface.
 */
function xchainFeeDebit(ctx, gas) {
    if (ctx.feeMode === 'native') return false;
    if (ctx.feeMode === 'xchain') return true;
    return !gas || gas.coin === 'BTC';
}

/*
 * Price ONE ISSUE sub-command's protocol fee, in the gas token.
 *
 * Mirrors what the arbiter can price (indexer batch.js nominalIssueFee /
 * isGasProvablyUnaffordable): a NEW non-caret, non-gas TICK costs the schedule
 * price, top-level or child by the dot; a tick that already carries a valid
 * issuance is a free re-issue.
 *
 * Returns { amount, chargeable, bound } - chargeable:false meaning "priced at
 * zero, this one cannot be shown unaffordable" - or null when the price is NOT
 * knowable client-side (caret reference, unreachable token row, no schedule).
 * Null is what keeps a guess out of the balance verdict.
 *
 * `bound` marks a quote that is a guaranteed LOWER bound of what the chain
 * bills, which is the grade the whole-batch collapse verdict requires: a
 * too-low bound can only suppress a collapse, never cause a wrong one. An
 * issuance fee is a schedule constant, so it is exact and bound:true.
 */
async function projectIssueFee(ctx, cmd, gas) {
    if (!gas) return null;
    const p = cmd.params || {};
    const tick = p.TICK;
    if (!tick || Array.isArray(tick)) return null;
    const name = String(tick).trim();
    // A caret TICK is an id reference the arbiter resolves rather than prices,
    // and the gas token's own genesis issuance is fee-exempt (chicken-and-egg).
    if (name === '' || name.charAt(0) === '^') return null;
    if (name.toUpperCase() === String(GAS_TICK).toUpperCase())
        return { amount: '0', chargeable: false, bound: true };
    const token = await ctx.token(name);
    if (token === undefined) return null;                        // lookup unavailable
    if (token !== null) return { amount: '0', chargeable: false, bound: true }; // exists: free re-issue
    const units = classifyIssueTick(name) === CHILD_ISSUE_KEY
        ? gas.schedule.ISSUE_SUBTOKEN
        : gas.schedule.ISSUE;
    if (units === undefined || units === null) return null;
    const amount = gasFee(String(units), gas.gasPrice);
    return { amount, chargeable: numeric.isPositive(amount), bound: true };
}

/*
 * Price ONE duration-metered CREATE (ORDER / SWAP / DISPENSER format 0), in
 * the gas token, from the wire's own EXPIRATION - the arbiter's
 * nominalDurationFee scope. Only the create format is priceable: v1 is a
 * cancel and v2 an edit whose fee is a difference against stored state, so
 * both answer null (cost not positively known), exactly as the arbiter does.
 * No EXPIRATION is the free case, a positive answer of zero.
 *
 * The arithmetic is the chain's own (seconds to days at 0 decimals, which
 * rounds to NEAREST; the free window; per-day gas at GAS_PRICE), with ONE
 * deliberate divergence: the chain evaluates it at the confirming block's
 * BLOCK_TIME and this side only has the wall clock. Confirmation happens
 * AFTER now, and the fee SHRINKS as the block time advances, so a quote taken
 * at now is an UPPER estimate, not a lower bound - it can overstate what a
 * later-confirming create is billed. bound:false records that: the quote
 * feeds the batch-total warning honestly, and may never feed the whole-batch
 * collapse error, which only lower-bound-grade prices can justify.
 */
function projectDurationFee(cmd, gas) {
    if (!gas) return null;
    if (String(cmd.version) !== '0') return null;
    const perDay = gas.schedule.EXPIRATION_PER_DAY;
    if (perDay === undefined || perDay === null) return null;
    const exp = (cmd.params || {}).EXPIRATION;
    if (Array.isArray(exp)) return null;
    const expiration = exp === undefined || exp === null ? '' : String(exp).trim();
    if (expiration === '') return { amount: '0', chargeable: false, bound: true };
    if (!util.isNumeric(expiration)) return null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expireDays = util.bcdiv(util.bcsub(expiration, nowSeconds, 0), 86400, 0);
    const chargeableDays = util.bcsub(expireDays, gas.freeDays, 0);
    if (!numeric.isPositive(chargeableDays))
        return { amount: '0', chargeable: false, bound: false };
    const gasCost = util.bcmul(chargeableDays, perDay, 0);
    const amount = gasFee(gasCost, gas.gasPrice);
    return { amount, chargeable: numeric.isPositive(amount), bound: false };
}

/*
 * Price ONE EXECUTE at its acceptance floor - the arbiter's
 * nominalExecuteFee. The floor is a schedule constant (VM_EXECUTE_BASE at
 * GAS_PRICE), read from no param: what the handler bills is gas actually
 * consumed, which starts at this base and only grows, so the floor is a true
 * lower bound and the one VM quote that is collapse-grade (bound:true).
 *
 * The gas-token probe is not optional: on a chain where the gas token has no
 * valid issuance the handler's whole fee block is skipped and an EXECUTE
 * really can be valid on an empty balance, so an unavailable or absent token
 * row answers null (unknown), never a positive price. The context memoizes
 * the lookup, so a batch of EXECUTEs pays for one read.
 *
 * XEXEC is deliberately NOT priced here or anywhere: it is system-injected
 * and fee-less on this chain (it cannot even be encoded client-side), so any
 * positive quote for it would be an over-estimate.
 */
async function projectExecuteFee(ctx, gas) {
    if (!gas) return null;
    const base = gas.schedule.VM_EXECUTE_BASE;
    if (base === undefined || base === null) return null;
    const token = await ctx.token(GAS_TICK);
    if (token === undefined || token === null) return null;
    const amount = gasFee(String(base), gas.gasPrice);
    return { amount, chargeable: numeric.isPositive(amount), bound: true };
}

/*
 * Do the protocol fees this batch charges fit the source's gas-token balance?
 *
 * No single sub-command is unaffordable here; 250 of them together are, and
 * no per-command check can see that. Priced classes mirror the arbiter's own
 * priceability scope: a new-tick ISSUE at the schedule price, an ORDER / SWAP
 * / DISPENSER format-0 create at its expiration fee, and an EXECUTE at its
 * VM acceptance floor. MINT and XEXEC are pinned OUT of pricing (see the
 * loop). Two verdicts, and the split is the whole point, because the chain
 * has two behaviours and only one of them is a rejection of the batch:
 *
 * ERROR - the arbiter's own whole-batch collapse (indexer batch.js
 *   isGasProvablyUnaffordable, `invalid: GAS (insufficient)`), which fires on
 *   the MINIMUM, never the sum: every sub-command must carry a positively
 *   priced LOWER-BOUND quote (`bound`, folded into `allPriced` by the loop)
 *   and the balance must not cover even the CHEAPEST of them. Then nothing
 *   can be paid: where the collapse flag is armed the whole transaction is
 *   one invalid record, and below it every sub-command still fails
 *   individually, so the verdict never refuses a batch that could do work.
 *   Duration quotes are NOT collapse-grade (see projectDurationFee): pricing
 *   them from the wall clock can overstate a later-confirming create, and an
 *   overstated cheapest is exactly the over-collapse this grade exists to
 *   forbid.
 *
 * WARNING - balance covers the cheapest but not the total. Gas is billed
 *   GREEDILY in list order against one running budget, so a source holding gas
 *   for K of N lands exactly K valid commands (acceptance A6, driven on BTC
 *   regtest: 8 children with gas for 6 -> 6 valid, 2 rejected, 6 debits). The
 *   batch is NOT atomic and those K really do succeed, so erroring on the SUM
 *   would refuse a transaction the chain accepts - the false-block this whole
 *   severity model exists to prevent (spec §4.2). Say which K instead.
 *
 * `fees` carries one entry per PRICEABLE-CLASS sub-command in list order, or
 * null for one whose cost is not knowable client-side; a single null (or any
 * command outside the priced classes) disables the collapse verdict exactly
 * as it disables the arbiter's, since an unpriced command may be the
 * affordable one.
 */
async function checkFeeBudget(ctx, fees, gas, allPriced) {
    if (!fees.length) return;
    if (!xchainFeeDebit(ctx, gas)) {
        ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT,
            'protocol fees are settled as a native-coin output on this chain; no balance to check them against');
        return;
    }
    let total = '0';
    let cheapest = null;
    for (const fee of fees) {
        if (fee === null) continue;
        total = numeric.add(total, fee.amount);
        if (fee.chargeable && (cheapest === null || numeric.gt(cheapest, fee.amount))) cheapest = fee.amount;
    }
    if (!numeric.isPositive(total)) return;
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
    if (numeric.gte(balance, total)) return;

    const inFlight = ctx.deltaApplied(GAS_TICK);
    const netted = numeric.isPositive(inFlight);
    const netting = netted ? ` after ${inFlight} already committed from this wallet` : '';
    const local = netted ? { localDeltaApplied: inFlight } : {};

    // Every command carrying a chargeable lower-bound price, and not even the
    // cheapest is covered: nothing in the batch can pay its fee.
    if (allPriced && cheapest !== null && !numeric.gte(balance, cheapest)) {
        ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'error',
            `Balance of ${GAS_TICK} (${balance}${netting}) does not cover even the cheapest protocol fee in this `
            + `batch (${cheapest}); the chain rejects the whole batch as one record. Total charged: ${total}.`,
            { tick: GAS_TICK, balance, total, cheapest, commandCount: fees.length, wholeBatch: true, ...local });
        return;
    }

    // Partially funded: greedy list-order billing lands the prefix that fits.
    let affordable = 0;
    let spent = '0';
    for (const fee of fees) {
        if (fee === null) break;                       // unknown cost: stop counting honestly
        const next = numeric.add(spent, fee.amount);
        if (!numeric.gte(balance, next)) break;
        spent = next;
        affordable++;
    }
    ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'warning',
        `Balance of ${GAS_TICK} (${balance}${netting}) does not cover the ${total} of protocol fees this batch `
        + `charges. Commands are billed in order, so about ${affordable} of ${fees.length} would be paid and the `
        + 'rest would fail individually (a batch is not atomic).',
        { tick: GAS_TICK, balance, total, cheapest, affordable, commandCount: fees.length, ...local });
}

module.exports = {
    util,
    gasFee,
    DURATION_FEE_ACTIONS,
    gasConfig,
    xchainFeeDebit,
    projectIssueFee,
    projectDurationFee,
    projectExecuteFee,
    checkFeeBudget,
};
