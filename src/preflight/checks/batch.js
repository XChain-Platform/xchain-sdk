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
 * Pre-flight Tier-2: BATCH (spec §4.4 + §4.7 intra-BATCH projection).
 *
 * Recurses the action checks per sub-command with findings tagged by
 * command index. THE load-bearing rule: sub-command i is checked with
 * the PROJECTED balance deltas of sub-commands < i, so a legitimate
 * MINT-then-SEND-the-minted batch does not false-alarm. Where an
 * earlier command's effect cannot be projected client-side, dependent
 * findings cap at warning (handled by severity downgrade below).
 * BATCH is sequential and stateful, NOT atomic - standing warning.
 * Each sub-action pays its own fee; the header is fee-free. Tier-1
 * denylisted.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const coins = require('../../coins');
const { GAS_TICK } = require('../../protocol/constants.js');
const { BATCH_COMMAND_LIMIT, BATCH_WEIGHT_BUDGET, batchWeight, CHILD_ISSUE_KEY, classifyIssueTick }
    = require('../../batchLimits.js');
const Utility = require('../../utility.js');

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
 * balance error would false-block exactly the payer the native lane exists for
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

// Project a sub-command's effect on the source's token balances.
// Returns [{tick, amount}] deltas (positive = balance INCREASE) or
// null when the effect is not projectable client-side.
//
// `opts.issueFee` is the priced issuance fee from projectIssueFee. ISSUE used
// to be unprojectable outright, which downgraded every LATER balance finding in
// the batch to a warning - so a batch of 250 child issuances that could not
// afford the subtoken fees pre-flighted clean. Its two effects on the source's
// balances are the fee debit and the MINT_SUPPLY credit, and both are priced
// here; without the fee, ISSUE stays unprojectable rather than under-stating.
function projectDeltas(cmd, source, opts) {
    if (!cmd || !cmd.ok) return [];
    const p = cmd.params || {};
    const ticks = [].concat(p.TICK || []);
    const amounts = [].concat(p.AMOUNT || []);
    switch (cmd.action) {
        case 'MINT': {
            // Credits the destination (default: source).
            const dest = p.DESTINATION ? String(p.DESTINATION) : source;
            if (dest !== source) return [];
            return ticks.length && amounts.length ? [{ tick: String(ticks[0]), amount: String(amounts[0]), sign: +1 }] : [];
        }
        case 'ISSUE': {
            const fee = opts && opts.issueFee;
            if (!fee) return null;                 // fee unknown: stay unprojectable
            const out = [];
            if (numeric.isPositive(fee.amount))
                out.push({ tick: GAS_TICK, amount: String(fee.amount), sign: -1 });
            // MINT_SUPPLY mints fresh supply on every valid ISSUE, to the source
            // unless TRANSFER_SUPPLY names another address. Projecting it is what
            // keeps a legitimate issue-then-send-the-minted batch from false-erroring.
            const supply = p.MINT_SUPPLY;
            const dest = p.TRANSFER_SUPPLY ? String(p.TRANSFER_SUPPLY) : source;
            if (supply !== undefined && supply !== null && supply !== '' && !Array.isArray(supply)
                && numeric.isPositive(String(supply)) && dest === source && ticks.length)
                out.push({ tick: String(ticks[0]), amount: String(supply), sign: +1 });
            return out;
        }
        case 'SEND':
        case 'DESTROY': {
            const out = [];
            const n = Math.max(ticks.length, amounts.length);
            for (let i = 0; i < n; i++) {
                const tick = String(ticks[Math.min(i, ticks.length - 1)] || '');
                const amount = String(amounts[i] !== undefined ? amounts[i] : '');
                if (tick && amount !== '') out.push({ tick, amount, sign: -1 });
            }
            return out;
        }
        default:
            return null; // not projectable (sweeps, escrows, ...)
    }
}

/*
 * Global per-BATCH command cap, and the cost-weight budget that supersedes it
 * at/after BATCH_COST_WEIGHTING.
 *
 * Both reach the same on-chain rejection and both are reported the same way,
 * for the same reason: ten AIRDROPs weigh 250 and fit, eleven weigh 275 and the
 * whole batch rejects, while the command count is still nowhere near 250. A
 * client composing fan-out or VM batches can now be refused on weight alone,
 * which counting commands cannot see.
 *
 * WARNING, not an error, and deliberately so. The 250-command cap arrived with
 * BATCH_ISSUANCE_LIMITS, now ARMED on every network (mainnet at
 * 2026-08-16T00:00:00Z), so that half no longer rests on an unarmed flag; the
 * WEIGHT budget beside it rides BATCH_COST_WEIGHTING, which is live on testnet
 * and regtest and still unarmed on mainnet. Pre-flight has no chain height or
 * flag state to tell those apart, and an over-weight batch is still accepted on
 * mainnet, so a non-overridable client error would false-block it (spec §4.2).
 *
 * decoder/parse.js raises the same finding from the same shared scan, and
 * universal.js passes validator findings through, so emit here only when that
 * path did not already carry it - one report, one cap line.
 */
function checkCommandCap(ctx, commands) {
    const count = ctx.parsed.params && ctx.parsed.params.COMMAND !== undefined
        ? String(ctx.parsed.params.COMMAND).split(';').length
        : commands.length;
    // Weighed only when the count fits, the arbiter's ordering: every weight is
    // an integer >= 1, so a batch that fails the count would fail the budget too
    // and there is nothing to learn by weighing it.
    const raw = ctx.parsed.params && ctx.parsed.params.COMMAND !== undefined
        ? String(ctx.parsed.params.COMMAND).split(';')
        : commands;
    const weight = count > BATCH_COMMAND_LIMIT ? null : batchWeight(raw);
    if (count <= BATCH_COMMAND_LIMIT && weight <= BATCH_WEIGHT_BUDGET) return;
    ctx.markRun(FINDING_CODES.BATCH_LIMIT_EXCEEDED);
    const already = ctx.findings.some(f => f.code === FINDING_CODES.BATCH_LIMIT_EXCEEDED
        && f.data && f.data.action === 'COMMAND');
    if (already) return;
    // The weighted case says so in its own words. Both are the same on-chain
    // rejection (`invalid: COMMAND (limit)`), but a caller told "250 commands"
    // when it composed nine would have no idea what to change; the number that
    // moved is the weight, so that is the number reported.
    if (count > BATCH_COMMAND_LIMIT) {
        ctx.addFinding(FINDING_CODES.BATCH_LIMIT_EXCEEDED, 'warning',
            `This batch carries ${count} commands; the chain rejects the whole batch above ${BATCH_COMMAND_LIMIT}.`,
            { action: 'COMMAND', limit: BATCH_COMMAND_LIMIT, count });
        return;
    }
    ctx.addFinding(FINDING_CODES.BATCH_LIMIT_EXCEEDED, 'warning',
        `This batch's ${count} commands weigh ${weight}; the chain rejects the whole batch above `
        + `${BATCH_WEIGHT_BUDGET} once cost weighting is armed (it is live on testnet and regtest, `
        + `unarmed on mainnet).`,
        { action: 'COMMAND', limit: BATCH_WEIGHT_BUDGET, count, weight });
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

async function checkBatch(ctx) {
    const commands = ctx.parsed.commands || [];
    ctx.addFinding(FINDING_CODES.BATCH_NOT_ATOMIC, 'warning',
        'Batch commands execute sequentially and are NOT atomic: if one fails, earlier commands still apply.',
        { commandCount: commands.length });

    checkCommandCap(ctx, commands);

    // Running projected deltas, seeded from the caller's own localDeltas.
    // ctx.localDeltas is amounts to SUBTRACT; the projection uses the
    // same convention (positive amount = subtract from balance).
    const baseDeltas = ctx.localDeltas.slice();
    let projected = [];   // [{tick, amount}] to subtract
    let unprojectable = false;

    // Per-command protocol fees, in list order, checked once against the
    // gas-token balance after the loop. `allPriced` is the arbiter's own
    // all-or-nothing scope gate, with the client's lower-bound grade folded
    // in: one command without a positively-priced, collapse-grade quote and
    // the whole-batch collapse cannot be claimed.
    const gas = gasConfig(ctx.sdk);
    const fees = [];
    let allPriced = true;

    const { runActionChecks } = require('./index.js');

    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (!cmd || cmd.ok === false) {
            ctx.addFinding(FINDING_CODES.PARSE_INVALID, 'error',
                `Batch command ${i + 1} does not parse (${cmd && cmd.code ? cmd.code : 'MALFORMED'}).`,
                { commandIndex: i, code: cmd && cmd.code });
            allPriced = false;
            continue;
        }

        // Child context sharing the report sinks but with the running
        // projected deltas and the command index for finding tags.
        const child = Object.create(ctx);
        child.parsed = cmd;
        child.params = cmd.params || {};
        child.commandIndex = i;
        child.localDeltas = baseDeltas.concat(projected);
        const findingsBefore = ctx.findings.length;
        await runActionChecks(child);

        // §4.4: where an earlier command's effect could not be
        // projected, dependent balance findings cap at warning.
        if (unprojectable) {
            for (let f = findingsBefore; f < ctx.findings.length; f++) {
                const finding = ctx.findings[f];
                if (finding.severity === 'error' && finding.code === FINDING_CODES.BALANCE_INSUFFICIENT) {
                    finding.severity = 'warning';
                    delete finding.overridable;
                    finding.message += ' (an earlier batch command\'s effect could not be projected; treat as advisory)';
                }
            }
        }

        // This command's protocol fee, where the class is priceable. An
        // ISSUE's is priced here (it needs the token row, which projectDeltas
        // cannot fetch) and both accumulated for the batch-wide budget check
        // and handed to the projection as this command's debit. Where the fee
        // is a coin output rather than a balance debit there is nothing to
        // subtract, but the command is still fully projected: a zero fee is
        // knowledge, not an unknown.
        let issueFee = null;
        if (cmd.action === 'ISSUE') {
            issueFee = xchainFeeDebit(ctx, gas)
                ? await projectIssueFee(ctx, cmd, gas)
                : { amount: '0', chargeable: false, bound: true };
            fees.push(issueFee);
            if (issueFee === null || !issueFee.chargeable || !issueFee.bound) allPriced = false;
        } else if (DURATION_FEE_ACTIONS.includes(cmd.action)) {
            const fee = xchainFeeDebit(ctx, gas)
                ? projectDurationFee(cmd, gas)
                : { amount: '0', chargeable: false, bound: true };
            fees.push(fee);
            if (fee === null || !fee.chargeable || !fee.bound) allPriced = false;
        } else if (cmd.action === 'EXECUTE') {
            const fee = xchainFeeDebit(ctx, gas)
                ? await projectExecuteFee(ctx, gas)
                : { amount: '0', chargeable: false, bound: true };
            fees.push(fee);
            if (fee === null || !fee.chargeable || !fee.bound) allPriced = false;
        } else {
            // Every other class refuses to price, so it disables the collapse.
            // Two are pinned OUT rather than merely unbuilt: MINT is free
            // on-chain and its real cost is the token's contract code, which
            // no param can reveal, so any positive quote would be invented;
            // XEXEC is system-injected and fee-less (it does not even parse
            // client-side). The rest (BET, AIRDROP, DIVIDEND, CALLBACK,
            // SWEEP, DEPLOY) price off recipient counts, db hits or code
            // bytes inside their handlers.
            allPriced = false;
        }

        const deltas = projectDeltas(cmd, ctx.source, { issueFee });
        if (deltas === null) unprojectable = true;
        else {
            for (const d of deltas) {
                // sign +1 = credit => subtract a negative amount.
                projected.push({ tick: d.tick, amount: d.sign > 0 ? numeric.sub('0', d.amount) : d.amount });
            }
        }
    }

    await checkFeeBudget(ctx, fees, gas, allPriced);
}

module.exports = { checkBatch, projectDeltas };
