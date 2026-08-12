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
 * Pre-flight Tier-2: DISPENSER (open/edit/close) + DISPENSE (buy).
 * Spec §4.4 rows; mirrors xchain-indexer src/actions/dispenser.js.
 *
 * DISPENSE is the row Tier 1 CANNOT validate (feeExempt: the handler
 * never runs on the quote path, and the synthetic tx cannot carry the
 * settlement outputs), and it MOVES NATIVE COIN - so the client tier
 * is the only pre-sign protection: dispenser exists, resolved state
 * is open (client lifecycle resolver, §7), and give-remaining covers
 * the request.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, MAX_REFILLS } = require('../constants.js');
const numeric = require('../numeric.js');
const { resolveDispenserState, resolveGiveRemaining } = require('../resolvers.js');

/*
 * PRICE v1 oracle usage fee . A Mode B dispenser - one naming an
 * ORACLE_ADDRESS - pays the oracle operator up front, as a real native-coin
 * OUTPUT inside the DISPENSER transaction, and the indexer rejects the open or
 * refill when that output is missing or short of the tolerance band.
 *
 * Pre-flight cannot check it and never will: it is handed an action STRING,
 * and the rule is about outputs that only exist once the encoder has built the
 * transaction. The wallet enforces it at compose instead, hard-refusing an
 * unquotable Mode B dispenser (core/src/sdk/oracleFeePreflight.js), which is
 * the correct layer - it is also the layer that can size the output. Declaring
 * it unverified here keeps a whole rejection class from reading as a clean
 * pass on any surface that pre-flights without composing.
 *
 *  changed what TIER 1 does with the same rule, not what Tier 2 can see:
 * a read-only dry run has no transaction and therefore no outputs, so the
 * output half could only ever fail there, and it demanded the very amount the
 * refused quote existed to compute. The quote path now checks the knowable half
 * (the oracle has an effective price, valued against a validator price) and
 * skips the impossible one, so a Mode B dispenser gets a real verdict instead
 * of a structural refusal. This declaration is what remains the gap.
 */
function noteOracleFee(ctx, oracleAddress) {
    if (!oracleAddress) return;
    ctx.addUnverified(FINDING_CODES.DISPENSER_ORACLE_FEE,
        'the oracle usage fee is an output-level rule; the wallet checks it at compose time');
}

async function checkDispenser(ctx) {
    const version = String(ctx.parsed.version);
    if (version === '0') {
        // Open: flat hasBalance(GIVE_ESCROW), skipped when
        // GIVE_OWNERSHIP=1 (dispenser.js). EXPIRATION is block TIME,
        // not height - local warning only.
        const giveTick = ctx.field('GIVE_TICK');
        const escrow = ctx.field('GIVE_ESCROW');
        const giveOwnership = ctx.field('GIVE_OWNERSHIP') === '1';
        if (!giveOwnership && giveTick && escrow && ctx.source) {
            const balance = await ctx.balance(ctx.source, giveTick);
            if (balance === null) {
                ctx.addUnverified(FINDING_CODES.BALANCE_INSUFFICIENT, 'balance lookup unavailable for ' + giveTick);
            } else {
                ctx.markRun(FINDING_CODES.BALANCE_INSUFFICIENT);
                if (!numeric.gte(balance, escrow)) {
                    // §4.7 netting, same treatment as the SEND check.
                    const inFlight = ctx.deltaApplied(giveTick);
                    const netted = numeric.isPositive(inFlight);
                    ctx.addFinding(FINDING_CODES.BALANCE_INSUFFICIENT, 'error',
                        netted
                            ? `Balance of ${giveTick} (${balance} after ${inFlight} already committed from this wallet) `
                                + `does not cover the escrow (${escrow}).`
                            : `Balance of ${giveTick} (${balance}) does not cover the escrow (${escrow}).`,
                        { tick: giveTick, balance, escrow, ...(netted ? { localDeltaApplied: inFlight } : {}) });
                }
            }
        }
        ctx.addUnverified('DISPENSER_ORIGIN_STANDING',
            'origin-standing / UTXO-freshness gate is server-side (and unreliable even on the quote path)');
        noteOracleFee(ctx, ctx.field('ORACLE_ADDRESS'));
        return;
    }

    // v1 cancel / v2 edit: dispenser exists; owner is SOURCE or
    // GET_ADDRESS (dispenser.js:298-302); live lifecycle read from the
    // action route's state block (warning-max).
    const idx = ctx.field('DISPENSER_ACTION_INDEX');
    if (!idx) return;
    const { found, state, dispenser } = await resolveDispenserState(ctx, idx);
    ctx.markRun(FINDING_CODES.DISPENSER_NOT_FOUND);
    if (found === undefined) {
        ctx.addUnverified(FINDING_CODES.DISPENSER_NOT_FOUND, 'dispenser lookup unavailable');
        return;
    }
    if (found === false) {
        ctx.addFinding(FINDING_CODES.DISPENSER_NOT_FOUND, 'error',
            `Dispenser #${idx} does not exist.`, { dispenserActionIndex: idx });
        return;
    }
    if (state === null) {
        ctx.addUnverified('DISPENSER_LIFECYCLE', 'the lookup carried no dispenser status');
    } else if (state !== 'open') {
        ctx.addFinding('DISPENSER_LIFECYCLE', 'warning',
            `Dispenser #${idx} is ${state}; this ${ctx.parsed.version === 1 ? 'cancel' : 'edit'} will likely be rejected.`,
            { dispenserActionIndex: idx, state });
    }
    if (ctx.source && dispenser) {
        const owner = String(dispenser.source ?? dispenser.owner ?? '');
        const getAddress = String(dispenser.get_address ?? dispenser.GET_ADDRESS ?? '');
        if (owner && ctx.source !== owner && (!getAddress || ctx.source !== getAddress)) {
            ctx.addFinding('DISPENSER_NOT_OWNER', 'warning',
                `Source is neither the dispenser owner (${owner}) nor its GET_ADDRESS; the chain will reject this.`,
                { dispenserActionIndex: idx, owner, getAddress });
        }
    }

    // A v2 edit that tops up GIVE_ESCROW is a REFILL, and refills carry two
    // rules a plain edit does not: the MAX_REFILLS cap  and, on a Mode
    // B dispenser, the oracle usage fee on the amount being added .
    if (version !== '2') return;
    const topUp = ctx.field('GIVE_ESCROW');

    // An ownership dispenser never holds balance escrow, on edit as on create.
    // The create-time half is authoring-only (validator.js, GIVE_OWNERSHIP is on
    // the wire there); an EDIT targets the dispenser by action index and never
    // restates the flag, so only this state lookup can see it. Without the rule
    // the edit debited GIVE_ESCROW while both terminal paths credit nothing back,
    // stranding the balance (xchain-indexer src/actions/dispenser.js, ).
    //
    // Ahead of the refill early-return below on purpose: the handler guards with
    // isNull, not isPositive, so a supplied GIVE_ESCROW of 0 is still supplied and
    // still rejected, while the refill path ignores it as a non-top-up.
    //
    // Warning, never an error. The chain gates this on the dispenser-family
    // cohort, and pre-flight has no chain height, so a hard block would false-block
    // a legal pre-activation edit (spec §4.2), the same reasoning as the `^id`
    // rule in universal.js.
    const ownershipDispenser = String(dispenser?.give_ownership ?? dispenser?.GIVE_OWNERSHIP ?? '0') === '1';
    ctx.markRun(FINDING_CODES.DISPENSER_OWNERSHIP_ESCROW);
    if (ownershipDispenser && topUp !== null && topUp !== undefined && topUp !== '') {
        ctx.addFinding(FINDING_CODES.DISPENSER_OWNERSHIP_ESCROW, 'warning',
            `Dispenser #${idx} is an ownership dispenser (GIVE_OWNERSHIP=1), which cannot hold escrow; `
            + 'the chain rejects an edit that supplies GIVE_ESCROW.',
            { dispenserActionIndex: idx, giveEscrow: topUp });
    }

    if (!topUp || !numeric.isPositive(topUp)) return;

    // The refill's oracle address is the DISPENSER's, not the edit's: a
    // format-2 payload targets the dispenser by action index and never
    // restates the oracle.
    noteOracleFee(ctx, String(dispenser?.oracle_address ?? dispenser?.ORACLE_ADDRESS ?? ''));

    // MAX_REFILLS is an §7 ENDPOINT GAP, not a check. Counting refills needs
    // valid DISPENSER_EDIT rows carrying give_escrow > 0 (the indexer's own
    // predicate, db.getDispenserRefillCount), and /dispenser_edits/ serves
    // neither: it omits the give_escrow column and accepts only block/address,
    // not a dispenser reference. Declared rather than approximated - a refill
    // count that silently reads 0 would be a check that can never fire, which
    // is indistinguishable from a passing one.
    ctx.addUnverified(FINDING_CODES.DISPENSER_MAX_REFILLS,
        `the ${MAX_REFILLS}-refill cap is not derivable client-side: /dispenser_edits/ exposes no give_escrow`);
}

async function checkDispense(ctx) {
    // DISPENSE row (v3 addition): un-dry-runnable, moves native coin.
    const idx = ctx.field('DISPENSER_ACTION_INDEX') || ctx.field('ACTION_INDEX');
    if (!idx) {
        ctx.addUnverified(FINDING_CODES.DISPENSER_NOT_FOUND, 'no dispenser reference in params');
        return;
    }
    const { found, state, dispenser } = await resolveDispenserState(ctx, idx);
    ctx.markRun(FINDING_CODES.DISPENSER_NOT_FOUND);
    ctx.markRun(FINDING_CODES.DISPENSER_NOT_OPEN);
    if (found === undefined) {
        ctx.addUnverified(FINDING_CODES.DISPENSER_NOT_FOUND, 'dispenser lookup unavailable');
        return;
    }
    if (found === false) {
        ctx.addFinding(FINDING_CODES.DISPENSER_NOT_FOUND, 'error',
            `Dispenser #${idx} does not exist.`, { dispenserActionIndex: idx });
        return;
    }
    // An unknown status is NOT an open one, but it is not grounds for an error
    // either: this finding is the hard "your coin moves and then it fails"
    // block, so it fires only on a status the route actually stated.
    if (state === null) {
        ctx.addUnverified(FINDING_CODES.DISPENSER_NOT_OPEN, 'the lookup carried no dispenser status');
    } else if (state !== 'open') {
        ctx.addFinding(FINDING_CODES.DISPENSER_NOT_OPEN, 'error',
            `Dispenser #${idx} is ${state}, not open. A dispense against it will fail AFTER your native coin moves.`,
            { dispenserActionIndex: idx, state });
    }

    const remaining = await resolveGiveRemaining(ctx, dispenser, idx);
    ctx.markRun(FINDING_CODES.DISPENSER_EMPTY);
    const giveAmount = String(dispenser.give_amount ?? dispenser.GIVE_AMOUNT ?? '0');
    // Say so rather than let an unresolvable give-remaining read as headroom:
    // markRun above has already claimed this check ran.
    if (remaining === null)
        ctx.addUnverified(FINDING_CODES.DISPENSER_EMPTY, 'give-remaining could not be resolved');
    if (remaining !== null && numeric.isPositive(giveAmount) && !numeric.gte(remaining, giveAmount)) {
        ctx.addFinding(FINDING_CODES.DISPENSER_EMPTY, 'error',
            `Dispenser #${idx} has ${remaining} remaining, less than one fill (${giveAmount}).`,
            { dispenserActionIndex: idx, remaining, giveAmount });
    }

    ctx.addUnverified('DISPENSE_SETTLEMENT_MATCH',
        'exact settlement-output matching is structural and unknowable before the transaction exists');
}

module.exports = { checkDispenser, checkDispense };
