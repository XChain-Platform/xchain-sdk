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
const { GAS_TICK } = require('../../protocol/constants.js');
const { BATCH_COMMAND_LIMIT, BATCH_WEIGHT_BUDGET, batchWeight }
    = require('../../protocol/batch_limits.js');
const {
    DURATION_FEE_ACTIONS,
    gasConfig,
    xchainFeeDebit,
    projectIssueFee,
    projectDurationFee,
    projectExecuteFee,
    checkFeeBudget,
} = require('./batch/fee_projection.js');

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
function projectIssueDeltas(p, ticks, source, opts) {
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

function projectSendDeltas(p, ticks, amounts, source) {
    // Debits every leg, and credits back the ones addressed to the source.
    // A settled SEND writes TWO ledger rows - debit SOURCE, credit
    // DESTINATION (indexer src/actions/send.js) - so a self-addressed leg
    // is balance-neutral for every LATER command in the batch, and
    // projecting it as a pure loss false-errors the next one with
    // BALANCE_INSUFFICIENT. The intra-command check in checks/send.js
    // still counts the leg as a spend, which mirrors the handler's own
    // per-leg debit of its in-memory snapshot.
    //
    // DESTINATION is one entry per leg, parallel to AMOUNT, on every SEND
    // version (v1 repeats AMOUNT/DESTINATION under one TICK; v2/v3 repeat
    // TICK too, which is why the tick index clamps and these do not).
    // Compared as a raw string, as MINT above does: a leg whose
    // destination is missing or spelled any other way keeps its debit, so
    // an unknown spelling over-states the spend rather than letting an
    // unaffordable batch pre-flight clean.
    const out = [];
    const dests = [].concat(p.DESTINATION || []);
    const n = Math.max(ticks.length, amounts.length);
    for (let i = 0; i < n; i++) {
        const tick = String(ticks[Math.min(i, ticks.length - 1)] || '');
        const amount = String(amounts[i] !== undefined ? amounts[i] : '');
        if (!tick || amount === '') continue;
        out.push({ tick, amount, sign: -1 });
        if (dests[i] !== undefined && String(dests[i]) === source)
            out.push({ tick, amount, sign: +1 });
    }
    return out;
}

function projectDestroyDeltas(ticks, amounts) {
    // Debit-only: DESTROY burns the supply and has no DESTINATION.
    const out = [];
    const n = Math.max(ticks.length, amounts.length);
    for (let i = 0; i < n; i++) {
        const tick = String(ticks[Math.min(i, ticks.length - 1)] || '');
        const amount = String(amounts[i] !== undefined ? amounts[i] : '');
        if (tick && amount !== '') out.push({ tick, amount, sign: -1 });
    }
    return out;
}

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
        case 'ISSUE':
            return projectIssueDeltas(p, ticks, source, opts);
        case 'SEND':
            return projectSendDeltas(p, ticks, amounts, source);
        case 'DESTROY':
            return projectDestroyDeltas(ticks, amounts);
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
 * BATCH_ISSUANCE_LIMITS, ARMED on every network (mainnet at
 * 2026-08-16T00:00:00Z); the WEIGHT budget beside it rides BATCH_COST_WEIGHTING,
 * whose mainnet constant the 2026-09-09 ruling moved to genesis
 * (BATCH_COST_WEIGHTING_MAINNET_TIME = 0 in xchain-indexer/src/protocol_changes.js).
 * The weighting gate only ever evaluates INSIDE the issuance-limits gate, so its
 * effective mainnet activation is that entry's 2026-08-16T00:00:00Z - past either
 * way, and both halves are in force on mainnet today. It stays a warning because
 * pre-flight resolves neither the network nor the including block's consensus
 * time, so it cannot certify which gate the action lands under, and a
 * non-overridable client error on an advisory reading would false-block
 * (spec §4.2). Raising it to an error is a client-behaviour change with its own
 * blast radius and is not made here.
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
        + `${BATCH_WEIGHT_BUDGET} (cost weighting is in force on every network: testnet and regtest `
        + `from genesis, mainnet from 2026-08-16T00:00:00Z).`,
        { action: 'COMMAND', limit: BATCH_WEIGHT_BUDGET, count, weight });
}

// Child context sharing the report sinks but with the running
// projected deltas and the command index for finding tags.
async function runCommandChecks(ctx, cmd, i, baseDeltas, projected, unprojectable, runActionChecks) {
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
}

// This command's protocol fee, where the class is priceable. An
// ISSUE's is priced here (it needs the token row, which projectDeltas
// cannot fetch) and both accumulated for the batch-wide budget check
// and handed to the projection as this command's debit. Where the fee
// is a coin output rather than a balance debit there is nothing to
// subtract, but the command is still fully projected: a zero fee is
// knowledge, not an unknown.
async function projectCommandFee(ctx, cmd, gas) {
    let fee = null;
    let priceable = true;
    if (cmd.action === 'ISSUE') {
        fee = xchainFeeDebit(ctx, gas)
            ? await projectIssueFee(ctx, cmd, gas)
            : { amount: '0', chargeable: false, bound: true };
    } else if (DURATION_FEE_ACTIONS.includes(cmd.action)) {
        fee = xchainFeeDebit(ctx, gas)
            ? projectDurationFee(cmd, gas)
            : { amount: '0', chargeable: false, bound: true };
    } else if (cmd.action === 'EXECUTE') {
        fee = xchainFeeDebit(ctx, gas)
            ? await projectExecuteFee(ctx, gas)
            : { amount: '0', chargeable: false, bound: true };
    } else {
        // Every other class refuses to price, so it disables the collapse.
        // Two are pinned OUT rather than merely unbuilt: MINT is free
        // on-chain and its real cost is the token's contract code, which
        // no param can reveal, so any positive quote would be invented;
        // XEXEC is system-injected and fee-less (it does not even parse
        // client-side). The rest (BET, AIRDROP, DIVIDEND, CALLBACK,
        // SWEEP, DEPLOY) price off recipient counts, db hits or code
        // bytes inside their handlers.
        priceable = false;
    }
    return {
        fee,
        issueFee: cmd.action === 'ISSUE' ? fee : null,
        priceable,
        collapseGrade: priceable && fee !== null && fee.chargeable && fee.bound,
    };
}

function projectRunningDeltas(cmd, source, issueFee) {
    const deltas = projectDeltas(cmd, source, { issueFee });
    if (deltas === null) return null;
    return deltas.map(d => ({
        tick: d.tick,
        // sign +1 = credit => subtract a negative amount.
        amount: d.sign > 0 ? numeric.sub('0', d.amount) : d.amount,
    }));
}

// Running projected deltas, seeded from the caller's own localDeltas.
// ctx.localDeltas is amounts to SUBTRACT; the projection uses the
// same convention (positive amount = subtract from balance).
//
// Per-command protocol fees, in list order, checked once against the
// gas-token balance after the loop. `allPriced` is the arbiter's own
// all-or-nothing scope gate, with the client's lower-bound grade folded
// in: one command without a positively-priced, collapse-grade quote and
// the whole-batch collapse cannot be claimed.
async function checkBatch(ctx) {
    const commands = ctx.parsed.commands || [];
    ctx.addFinding(FINDING_CODES.BATCH_NOT_ATOMIC, 'warning',
        'Batch commands execute sequentially and are NOT atomic: if one fails, earlier commands still apply.',
        { commandCount: commands.length });
    checkCommandCap(ctx, commands);

    const baseDeltas = ctx.localDeltas.slice();
    let projected = [];   // [{tick, amount}] to subtract
    let unprojectable = false;
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

        await runCommandChecks(ctx, cmd, i, baseDeltas, projected, unprojectable, runActionChecks);
        const pricing = await projectCommandFee(ctx, cmd, gas);
        if (pricing.priceable) fees.push(pricing.fee);
        if (!pricing.collapseGrade) allPriced = false;

        const deltas = projectRunningDeltas(cmd, ctx.source, pricing.issueFee);
        if (deltas === null) unprojectable = true;
        else projected.push(...deltas);
    }

    await checkFeeBudget(ctx, fees, gas, allPriced);
}

module.exports = { checkBatch, projectDeltas };
