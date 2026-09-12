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
 * How that handoff is MATCHED is itself conditional, on a second
 * flag-day. Above it the indexer resolves a caret-spelled sibling
 * MESSAGE DESTINATION and compares canonical addresses; below it the
 * comparison is a raw wire compare, and a `^id` spelling matches no
 * SEND DESTINATION, which is multi-valued and never compacted. This
 * SDK compacts a single-valued MESSAGE.DESTINATION by default
 * (addressRefFields.js), so a wallet-composed BATCH(SEND, MESSAGE) to
 * an indexed recipient carries exactly the spelling that pairs only
 * above the flag-day. The rule NARROWS rejection, so mirroring the
 * wire compare as an error would false-block wherever it is armed,
 * and it is declared rather than predicted.
 *
 * LEG-AMOUNT CONSOLIDATION is the second conditional, and it WIDENS
 * rejection rather than narrowing it. Above its flag-day both handlers
 * hold a leg whose RAW amount fails its tick's format out of the merge,
 * so it lands on the handler's per-leg check instead of being summed
 * into a total that passes: two 0.5 legs of a 0-decimals token used to
 * merge to '1' and settle.
 *
 * It is declared, not mirrored, and the distinction is load-bearing.
 * Predicting it needs the tick's DECIMALS *and* the activation state at
 * the block that will carry this action, and mainnet is UNARMED on the
 * house sentinel while testnet and regtest run it from genesis. A check
 * that raised the error unconditionally would reject on mainnet what
 * mainnet still accepts, which is the false-block this module's own
 * contract forbids and which the SDK has shipped once already.
 *
 * DESTROY has two BRIDGE supply-path refusals (the base bridge spec),
 * both UNCONDITIONAL on every plane and every height: the gas tick
 * off BTC ('use XBRIDGE v1') and a bridged copy `<ORIGIN>.<NAME>`
 * whose origin is another chain coin ('use XBRIDGE v4'). A burn here
 * would strand the escrow the supply shadows on the origin chain.
 * Both are mirrored as TICK_FORMAT warnings (the code is not
 * error-certified), keyed on the explorer's chain coin, and declared
 * instead when no chain coin is configured.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');
const { ALLOWED_COINS } = require('../../coins/index.js');
const { GAS_TICK } = require('../../protocol/constants.js');
const { planeFromCoin } = require('./issue.js');

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

// Name the leg-amount consolidation rule as unverified. Deciding it needs the
// tick's DECIMALS and the activation state at the including block, so it is
// declared here rather than predicted (see the header on the false-block risk).
function declareLegAmountRule(ctx, verb) {
    ctx.addUnverified('LEG_AMOUNT_CONSOLIDATION',
        `above its flag-day, a ${verb.toLowerCase()} leg whose amount does not fit its tick's decimals is `
        + 'rejected on its own instead of merging into a sibling leg; the activation state of the including '
        + 'block is server-side only, and mainnet is not armed for it');
}

async function checkSend(ctx) {
    await checkBalanceCovers(ctx, 'Send');
    declareLegAmountRule(ctx, 'Send');
    ctx.addUnverified('SEND_RESTRICTIONS',
        'sleep state, allow/block lists, controller-guard outcome, and the conditional gated-key handoff '
        + '(required only when the recipient\'s post-send balance reaches a pack threshold) are server-side only');
    // Which SPELLING of a handoff MESSAGE pairs with this send is decided by the
    // including block's activation state, so it is named rather than predicted
    // (see the header: mirroring the wire compare would false-block).
    ctx.addUnverified('GATED_HANDOFF_REF',
        'above its flag-day a gated-transfer key-handoff MESSAGE is paired with this send by RESOLVED address, '
        + 'and below it by raw wire spelling, so a ^id-compacted MESSAGE destination pairs only where the '
        + 'flag-day is armed; the activation state of the including block is server-side only, and mainnet '
        + 'is not armed for it');
}

// A bridged copy is `<ORIGIN>.<NAME>` with ORIGIN another chain coin (the indexer's
// parseBridgedTick): exactly two dot-separated parts, a non-empty name, and a
// prefix that is a chain coin other than this one. Same-chain `BTC.X` on BTC is a
// native subasset of the root, not a copy.
function bridgedOrigin(tick, localCoin) {
    const parts = String(tick).split('.');
    if (parts.length !== 2 || parts[1] === '') return null;
    const prefix = parts[0].toUpperCase();
    if (!ALLOWED_COINS.includes(prefix) || prefix === localCoin) return null;
    return prefix;
}

// The bridge supply-path refusals: a burn of supply that shadows an escrow held on
// another chain. Unconditional in the handler, so the only thing that can stop the
// mirror deciding is not knowing which chain this is.
function checkBridgeSupplyPath(ctx) {
    const plane = planeFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);
    const ticks = [].concat(ctx.params.TICK || []).map(t => String(t || '')).filter(Boolean);
    if (ticks.length === 0) return;
    if (!plane) {
        ctx.addUnverified('DESTROY_BRIDGE_SUPPLY',
            'the gas tick off BTC and a bridged copy (<ORIGIN>.<NAME> from another chain) cannot be '
            + 'destroyed, only unlocked through XBRIDGE; no chain coin is configured, so neither can be decided');
        return;
    }
    ctx.markRun(FINDING_CODES.TICK_FORMAT);
    for (const tick of ticks) {
        if (tick.toUpperCase() === GAS_TICK && plane.coin !== 'BTC') {
            ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
                `${tick} cannot be destroyed off BTC; its supply here shadows an escrow on BTC, so the indexer `
                + 'refuses this DESTROY (burn it through XBRIDGE v1 instead).',
                { tick, rule: 'use-xbridge-v1', coin: plane.coin });
            continue;
        }
        const origin = bridgedOrigin(tick, plane.coin);
        if (origin) {
            ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
                `${tick} is a bridged copy of a ${origin} token; its supply here shadows an escrow on ${origin}, `
                + 'so the indexer refuses this DESTROY (unlock it through XBRIDGE v4 instead).',
                { tick, rule: 'use-xbridge-v4', origin, coin: plane.coin });
        }
    }
}

async function checkDestroy(ctx) {
    await checkBalanceCovers(ctx, 'Destroy');
    declareLegAmountRule(ctx, 'Destroy');
    checkBridgeSupplyPath(ctx);
    ctx.addUnverified('DESTROY_RESTRICTIONS',
        'sleep state, allow/block lists, and burn-guard outcome are server-side only');
}

module.exports = { checkSend, checkDestroy, perTickTotals };
