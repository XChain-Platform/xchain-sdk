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

const { FINDING_CODES, EXPIRATION_MAX } = require('../constants.js');
const numeric = require('../numeric.js');
const { declareRepresentability, tokenDecimals, checkAmountField } = require('./amount_format.js');
const { checkDurationFee } = require('./duration_fee.js');
const { getCoinConfig } = require('../../coins/index.js');
const { parseCoinCode } = require('../../utils/endpoints.js');

// Decimal places of a chain coin code (the indexer's COIN_DECIMALS), or null.
function coinDecimals(coin) {
    const plane = parseCoinCode(coin);
    if (!plane) return null;
    try { return getCoinConfig(plane.coin, 'mainnet').decimals; } catch (e) { return null; }
}

/*
 * GIVE_AMOUNT and GET_AMOUNT of a create against their decimals, in the handler's
 * order. ORDER (xchain-indexer src/actions/order/validate.js:76-87): a native side
 * (empty TICK) is judged at COIN_DECIMALS, a token side at its token's DECIMALS, and
 * GET_AMOUNT is skipped on a cross-chain order (GET_COIN another chain). SWAP
 * (src/actions/swap/validate.js:70-75): each side only when its token row exists.
 * A token side whose row is absent is left to TOKEN_NOT_FOUND, which the handler
 * refuses first.
 */
async function checkTradeAmountFormats(ctx, noun) {
    if (String(ctx.parsed.version) !== '0') return;
    const plane = parseCoinCode(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);
    const sides = [['GIVE', 'GIVE_AMOUNT'], ['GET', 'GET_AMOUNT']];
    for (const [side, field] of sides) {
        const amount = ctx.field(field);
        if (amount === '' || Array.isArray(amount)) continue;
        const tick = ctx.field(side + '_TICK');
        const coin = ctx.field(side + '_COIN');
        let decimals = null;
        if (side === 'GET' && noun === 'ORDER') {
            if (!plane) { ctx.addUnverified(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'no chain coin is configured, so a cross-chain GET cannot be told apart'); continue; }
            if (coin && coin !== plane.coin) continue;
        }
        if (tick) {
            const token = await ctx.token(tick);
            if (token === undefined) { ctx.addUnverified(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'token lookup unavailable for ' + tick); continue; }
            decimals = tokenDecimals(token);
        } else if (noun === 'ORDER') {
            decimals = coinDecimals(coin);
        }
        if (checkAmountField(ctx, field, amount, decimals, tick ? { tick } : { coin })) return;
    }
}

/*
 * The EXPIRATION representability bound, mirrored from the handlers that carry
 * the field (xchain-indexer src/actions/order.js, swap.js, dispenser.js; the
 * dispenser copy lives in checks/dispenser.js and shares this reasoning).
 *
 * An EXPIRATION outside [0, EXPIRATION_MAX] is `invalid: EXPIRATION (format)`.
 * It is not normalized to NULL on the way to storage, so a client that says
 * nothing here tells the author "valid" for a payload every node refuses, and
 * the value it would have stored - no expiration at all - is an escrow that
 * never expires rather than the one they asked for.
 *
 * EVERY FORMAT THAT CARRIES THE FIELD, not just the create. The handler guards
 * this with isNull alone, with no format test, so a format-2 edit is judged by
 * the same rule; format 1 (cancel) carries no EXPIRATION and arrives here with
 * an empty field, which is what isNull answers true for. That is why this runs
 * ahead of the version fork in checkGiveBalance rather than inside it.
 *
 * ERROR, and so non-overridable, which VALIDATOR_SEMANTICS certifies as a local
 * code. The rule rides no activation table: its verdict is the same on every
 * plane at every height, this map's standing test for an error rather than a
 * warning. The negative half is refused even by a node predating the bound,
 * which reads a negative expiration as `invalid: EXPIRATION (past)`.
 *
 * The bound is exactly the handler's and no wider: a value the predicate cannot
 * prove out of range keeps its current verdict (numeric.js), and an EXPIRATION
 * that is merely far in the future, or already past, is not this check's to
 * judge - the tip it is measured against is server-side, which is what the
 * EXPIRY_IN_PAST notice below says.
 */
function checkExpirationRange(ctx) {
    const expiration = ctx.field('EXPIRATION');
    if (expiration === '') return;
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    if (!numeric.exceedsUnsignedColumn(expiration, EXPIRATION_MAX)) return;
    ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
        `EXPIRATION (${expiration}) is outside the range the chain can store (0 to ${EXPIRATION_MAX}); `
        + 'the indexer rejects this action as invalid: EXPIRATION (format).',
        { field: 'EXPIRATION', value: expiration, constraint: { min: '0', max: EXPIRATION_MAX } });
}

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
        ctx.addFinding(FINDING_CODES.GIVE_NOT_BALANCE_MODE, 'info',
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

async function checkTrade(ctx, noun) {
    checkExpirationRange(ctx);
    await checkGiveBalance(ctx, noun);
    await checkTradeAmountFormats(ctx, noun);
    if (String(ctx.parsed.version) === '0') declareRepresentability(ctx);
    await checkDurationFee(ctx);
}

async function checkOrder(ctx) { await checkTrade(ctx, 'ORDER'); }
async function checkSwap(ctx)  { await checkTrade(ctx, 'SWAP'); }

module.exports = { checkOrder, checkSwap };
