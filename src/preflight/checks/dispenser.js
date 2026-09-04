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
const { getCoinConfig } = require('../../coins/index.js');

// Decimal places of the chain coin a GET_COIN names, read from the vendored coin
// registry so the precision rule below cannot drift from the indexer's
// COIN_DECIMALS. Null for anything that is not a native coin code.
function nativeCoinDecimals(coin) {
    const m = /^[TR]?(BTC|LTC|DOGE)$/.exec(String(coin || '').toUpperCase());
    if (!m) return null;
    try { return getCoinConfig(m[1], 'mainnet').decimals; } catch (e) { return null; }
}

// Strictly-positive test that answers false, never throws, on a value the
// bignumber parser rejects: the indexer's own positivity rule reads a
// non-numeric string as "not greater than zero" too.
function isStrictlyPositive(v) {
    try { return numeric.isPositive(v); } catch (e) { return false; }
}

// A dispenser prices itself when it names neither a FIAT_CODE nor an
// ORACLE_ADDRESS; only then is GET_AMOUNT the price and subject to the
// amount-positivity rules.
function isSelfPriced(fiatCode, oracleAddress) {
    return !fiatCode && !oracleAddress;
}

/*
 * PRICE v1 oracle usage fee. A Mode B dispenser - one naming an
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
 * A later change altered what TIER 1 does with the same rule, not what Tier 2
 * can see: a read-only dry run has no transaction and therefore no outputs, so the
 * output half could only ever fail there, and it demanded the very amount the
 * refused quote existed to compute. The quote path now checks the knowable half
 * (the oracle has an effective price, valued against a validator price) and
 * skips the impossible one, so a Mode B dispenser gets a real verdict instead
 * of a structural refusal. This declaration is what remains the gap.
 *
 * A batch narrows the gap without closing it, and the difference matters. When
 * Mode B DISPENSERs ride inside a BATCH, /preflight now returns `oracleFeesOwed`:
 * the TOTAL owed per oracle address, summed across the batch's sub-commands
 * (indexer actions/dispenser.js). Tier 1 surfaces it as DRYRUN_ORACLE_FEES_OWED
 * info. That is a DISCLOSURE, deliberately not a verdict and deliberately not an
 * error - it is the number a composer needs to SIZE the outputs, computed by the
 * arbiter, and it says nothing about whether any output exists. Nothing about
 * Tier 2 changed: this check still sees an action string and no outputs, so the
 * declaration below stands exactly as written, and the sum arrives only for a
 * batch. A lone DISPENSER gets no such disclosure.
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
        // A balance dispenser must hand out something. Mirrors the Format-0
        // create rule in xchain-indexer/src/actions/dispenser.js: an absent or
        // non-positive GIVE_AMOUNT with GIVE_OWNERSHIP=0 opens a dispenser that
        // settles buyer payments as VALID fills crediting nothing, because every
        // downstream guard reads a non-positive GIVE_AMOUNT as "ownership
        // dispenser" and skips, while the auto-close threshold is that same
        // non-positive value, so it never closes and keeps absorbing payments.
        //
        // Warning rather than error, and deliberately so: the handler gates the
        // rejection behind dispenser_give_amount_activation, and preflight runs at
        // AUTHORING time with no block time to test the flag-day against. Below
        // the activation the chain still accepts this create, so calling it an
        // error would refuse a transaction the network takes. Above it, the
        // warning is the only notice a client gets before spending the fee. Same
        // treatment, and the same reasoning, as the `^id` caret-ref activation.
        if (!giveOwnership) {
            const giveAmount = ctx.field('GIVE_AMOUNT');
            if (!giveAmount || !numeric.isPositive(giveAmount)) {
                ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
                    'GIVE_AMOUNT is required and must be greater than 0 for a balance dispenser '
                        + '(GIVE_OWNERSHIP=0); at or above the activation the indexer rejects this create, '
                        + 'and below it the dispenser opens but credits nothing while absorbing payments.',
                    { giveAmount: giveAmount ?? null, giveOwnership: '0' });
            }
        }
        // A dispenser that names its own price must name a positive, well-formed
        // one. Mirrors the two Format-0 rules xchain-indexer/src/actions/dispenser.js
        // enforces behind dispenser_amount_positivity_activation: a native-coin-priced
        // GET_AMOUNT (empty GET_TICK) is checked against COIN_DECIMALS, which the
        // token-priced path always did and this path never had, and a GET_AMOUNT on
        // a dispenser with neither FIAT_CODE nor ORACLE_ADDRESS must be strictly
        // positive (the ORDER-AMT-1 shape). A negative price that reaches storage
        // settles dust payments as valid fills and manufactures escrow on close.
        //
        // Warning rather than error, for exactly the GIVE_AMOUNT reasoning above:
        // the handler gates both on the block's consensus time, pre-flight has no
        // block time, and mainnet is unarmed, so below the threshold the chain still
        // accepts the create.
        const getAmount = ctx.field('GET_AMOUNT');
        if (isSelfPriced(ctx.field('FIAT_CODE'), ctx.field('ORACLE_ADDRESS'))) {
            const decimals = ctx.field('GET_TICK') ? null : nativeCoinDecimals(ctx.field('GET_COIN'));
            if (getAmount && decimals !== null && !numeric.isValidAmountFormat(decimals, getAmount)) {
                ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'warning',
                    `GET_AMOUNT (${getAmount}) is not a valid ${ctx.field('GET_COIN')} amount at ${decimals} decimals; `
                        + 'at or above the activation the indexer rejects this create.',
                    { getAmount, getCoin: ctx.field('GET_COIN'), decimals });
            } else if (!getAmount || !isStrictlyPositive(getAmount)) {
                ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
                    'GET_AMOUNT is required and must be greater than 0 on a dispenser that names its own price '
                        + '(no FIAT_CODE, no ORACLE_ADDRESS); at or above the activation the indexer rejects this create, '
                        + 'and below it a non-positive price settles dust payments as valid fills.',
                    { getAmount: getAmount ?? null });
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
        ctx.addUnverified(FINDING_CODES.DISPENSER_LIFECYCLE, 'the lookup carried no dispenser status');
    } else if (state !== 'open') {
        ctx.addFinding(FINDING_CODES.DISPENSER_LIFECYCLE, 'warning',
            `Dispenser #${idx} is ${state}; this ${ctx.parsed.version === 1 ? 'cancel' : 'edit'} will likely be rejected.`,
            { dispenserActionIndex: idx, state });
    }
    if (ctx.source && dispenser) {
        const owner = String(dispenser.source ?? dispenser.owner ?? '');
        const getAddress = String(dispenser.get_address ?? dispenser.GET_ADDRESS ?? '');
        if (owner && ctx.source !== owner && (!getAddress || ctx.source !== getAddress)) {
            ctx.addFinding(FINDING_CODES.DISPENSER_NOT_OWNER_W, 'warning',
                `Source is neither the dispenser owner (${owner}) nor its GET_ADDRESS; the chain will reject this.`,
                { dispenserActionIndex: idx, owner, getAddress });
        }
    }

    // A v2 edit that tops up GIVE_ESCROW is a REFILL, and refills carry two
    // rules a plain edit does not: the MAX_REFILLS cap and, on a Mode
    // B dispenser, the oracle usage fee on the amount being added.
    if (version !== '2') return;
    const topUp = ctx.field('GIVE_ESCROW');

    // An ownership dispenser never holds balance escrow, on edit as on create.
    // The create-time half is authoring-only (validator.js, GIVE_OWNERSHIP is on
    // the wire there); an EDIT targets the dispenser by action index and never
    // restates the flag, so only this state lookup can see it. Without the rule
    // the edit debited GIVE_ESCROW while both terminal paths credit nothing back,
    // stranding the balance (xchain-indexer src/actions/dispenser.js).
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

    // The settlement half of dispenser_amount_positivity_activation
    // (xchain-indexer src/actions/dispense.js): the fill count must be strictly
    // positive, not merely non-zero, and a GET_AMOUNT the divide cannot parse is
    // rejected at the divide. Against a SELF-PRICED dispenser the count is
    // floor(payment / GET_AMOUNT), so a stored price that is non-numeric or not
    // positive fails every dispense, whatever the payment. The FIAT and oracle
    // paths price from elsewhere and are not predictable here.
    //
    // Warning, not error: the count rule is time-gated and pre-flight has no block
    // time, while a create that stored such a price predates the activation by
    // construction.
    const getAmount = dispenser.get_amount ?? dispenser.GET_AMOUNT;
    const selfPriced = isSelfPriced(dispenser.fiat_code ?? dispenser.FIAT_CODE,
        dispenser.oracle_address ?? dispenser.ORACLE_ADDRESS);
    if (selfPriced && getAmount !== undefined && getAmount !== null && String(getAmount) !== ''
        && !isStrictlyPositive(String(getAmount))) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            `Dispenser #${idx} prices at GET_AMOUNT ${getAmount}, which is not a positive amount; `
                + 'at or above the activation every dispense against it is rejected at settlement, '
                + 'AFTER your native coin moves.',
            { dispenserActionIndex: idx, getAmount: String(getAmount) });
    }

    // Settlement PRICING moved underneath this declaration without moving what
    // Tier 2 can see. A gated change (BATCH_ISSUANCE_LIMITS, xchain-indexer
    // src/actions/dispense.js) makes one payment settle a bounded number of fills
    // instead of buying a full multiplier against every dispenser it reaches: the
    // handler now keeps a running consumed-value tally and prices each dispenser
    // against what is LEFT, so a later dispenser behind the same paid address can
    // now fail where it previously settled. It also records the attributed cost as
    // the dispense row's GET_AMOUNT rather than the whole payment.
    //
    // Neither is checkable here, and not merely inconvenient to check: the tally is
    // keyed on COIN_AMOUNT and on the SET of open dispensers behind the paid
    // address, and pre-flight is handed an action string naming one dispenser,
    // before any transaction (and therefore any payment value) exists. Nothing this
    // check reads changes either - give-remaining is the GIVE-token side and the
    // record correction has no client consumer here.
    ctx.addUnverified('DISPENSE_SETTLEMENT_MATCH',
        'exact settlement-output matching is structural and unknowable before the transaction exists');
}

module.exports = { checkDispenser, checkDispense };
