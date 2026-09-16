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
 * XChain Platform SDK - BET (parimutuel betting) Helpers
 *
 * Pure builders for the four BET formats (see
 * xchain-documentation/protocol/actions/BET.md): v0 create a market, v1 cancel,
 * v2 place a bet, v3 resolve. Every rule mirrored here is a CONSENSUS rule the
 * indexer enforces; the point of duplicating them is that a malformed market
 * should fail in the caller's hands rather than after paying a fee to be
 * rejected on-chain. The SDK must never be stricter than consensus (that
 * refuses actions the protocol accepts) nor looser (that lets fees burn).
 *
 * The DETAILS schema lives here and is the single source of truth for it:
 * BET.md documents it, the wallet's create form is generated from it, and the
 * explorer renders against it. Only the shape rules the indexer actually checks
 * are enforced as errors (strict base64, size, JSON object, depth, and the
 * outcomes cross-check); every other key is convention and is validated only for
 * type, so a market carrying extra keys still composes.
 *
 * All pure: no network, no consensus. Submit-flow recipes live on
 * sdk.workflows (openMarket / placeBet / resolveMarket / cancelMarket); the raw
 * action wrapper is sdk.bet().
 *
 ********************************************************************/

const mathjs = require('mathjs');
const { BET_LIMITS, isSet, fail } = require('./bet_rules.js');

module.exports = {
    // Projected payout for a prospective stake at the current pools, computed in
    // the exact operation order and rounding direction settlement uses: fee is
    // floored first, then each payout is floored against the post-fee pot.
    //
    // Display-only. The real payout runs on the pools as they stand at resolve
    // time, and every later bet moves them. It is still done in mathjs bignumber
    // rather than JS floats, both because the amounts can carry 18 decimals and
    // because a projection that disagrees with the settled amount in the last
    // decimal place reads as a bug to the user. All values are returned as
    // fixed-decimal STRINGS at the token's precision, for the same reason.
    //
    // Returns null when the projection is undefined (an empty winning pool).
    //
    // pools    - per-outcome staked totals, indexed like OUTCOMES
    // outcome  - the outcome index being backed
    // stake    - the prospective stake
    // feePct   - the market's FEE, as a percent (1.00 = 1%)
    // decimals - the wager token's DECIMALS
    projectPayout({ pools, outcome, stake, feePct = 0, decimals = 8 } = {}) {
        const ctx = 'betting.projectPayout';
        if (!Array.isArray(pools)) fail('INVALID_FIELD_VALUE', `${ctx}: pools must be an array`, { field: 'pools' });

        const index = Number(outcome);
        if (!Number.isInteger(index) || index < 0 || index >= pools.length)
            fail('INVALID_FIELD_VALUE', `${ctx}: outcome is out of range for the pools given`, { field: 'outcome' });

        const d = Number(decimals);
        if (!Number.isInteger(d) || d < 0 || d > 18)
            fail('INVALID_FIELD_VALUE', `${ctx}: decimals must be an integer between 0 and 18`, { field: 'decimals' });

        const bn = mathjs.bignumber;
        const stakeBn = bn(String(stake == null ? 0 : stake));
        if (!(stakeBn.gt(0))) fail('INVALID_FIELD_VALUE', `${ctx}: stake must be positive`, { field: 'stake' });

        // Floor at `d` decimals. mathjs `format` with a precision ROUNDS, which
        // would overstate a payout by one base unit; settlement floors.
        //
        // The floor is decimal.js's native .floor(), matching the chain's own
        // bcmulfloordiv. mathjs.floor would smuggle the overstatement back in:
        // it tests nearlyEqual against relTol (default 1e-12) before flooring,
        // so a scaled quotient sitting just under the next base unit comes back
        // rounded UP - and a parimutuel quotient is exactly where a repeating
        // expansion lands there.
        const scale = mathjs.pow(bn(10), d);
        const floorAt = v => bn(v).times(scale).floor().div(scale);
        const fixed   = v => mathjs.format(v, { notation: 'fixed', precision: d });

        const total   = pools.reduce((sum, p) => mathjs.add(sum, bn(String(p == null ? 0 : p))), bn(0));
        const totalIn = mathjs.add(total, stakeBn);
        const winning = mathjs.add(bn(String(pools[index] == null ? 0 : pools[index])), stakeBn);
        if (!winning.gt(0)) return null;

        const fee    = floorAt(mathjs.divide(mathjs.multiply(totalIn, bn(String(feePct))), bn(100)));
        const pot    = mathjs.subtract(totalIn, fee);
        const payout = floorAt(mathjs.divide(mathjs.multiply(stakeBn, pot), winning));

        return {
            payout:      fixed(payout),
            profit:      fixed(mathjs.subtract(payout, stakeBn)),
            // Gross return per unit staked, the number a market page shows as
            // odds. Carried at 8 decimals regardless of the token's precision:
            // it is a ratio for display, not an amount.
            impliedOdds: mathjs.format(mathjs.divide(payout, stakeBn), { notation: 'fixed', precision: 8 }),
            total:       fixed(totalIn),
            winningPool: fixed(winning),
            fee:         fixed(fee)
        };
    },

    // Project what OPENING a market will cost, before the user signs it.
    //
    // Creation is duration-priced on the ORDER/DISPENSER expiration mechanism
    // (spec decision F), measured on the feed's full pass-eligible life,
    // `expire_at - BLOCK_TIME` -- NOT on DEADLINE. Short-lived markets, and
    // anyone trying the system out, create for nothing:
    //
    //     fee = max(0, days - freeDays) x perDay x gasPrice
    //
    // THE TRAP THIS EXISTS TO AVOID: the on-chain day count is
    // bcdiv(seconds, 86400, 0), which rounds HALF-UP rather than flooring. A
    // projection that floors disagrees with the chain at every fractional-day
    // boundary and quietly under-quotes by a whole day's fee (90.6 days is
    // billed as 91, not 90). Half-up is spelled out below as floor(x + 0.5)
    // rather than delegated to a rounding mode, so it cannot drift with mathjs
    // configuration.
    //
    // Defaults are the shipped BTC/LTC/DOGE schedule. Pass overrides if a chain
    // ever diverges; the caller can read them from the coin config.
    projectFeedCreateFee({
        deadline, refundWindow, blockTime, durationSeconds,
        freeDays = 90, perDay = 550, gasPrice = '0.00001'
    } = {}) {
        const ctx = 'betting.projectFeedCreateFee';
        const bn = mathjs.bignumber;

        let secs;
        if (isSet(durationSeconds)) {
            secs = Number(durationSeconds);
        } else {
            for (const [name, v] of [['deadline', deadline], ['blockTime', blockTime]])
                if (!isSet(v))
                    fail('MISSING_REQUIRED_FIELD',
                        `${ctx}: pass durationSeconds, or ${name} together with deadline/refundWindow/blockTime`,
                        { field: name });
            const window = isSet(refundWindow) ? Number(refundWindow) : BET_LIMITS.DEFAULT_BET_REFUND_WINDOW;
            secs = (Number(deadline) + window) - Number(blockTime);
        }

        if (!Number.isFinite(secs) || secs <= 0)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: the market's life must be a positive number of seconds (got ${secs})`,
                { field: 'durationSeconds', value: secs });

        // Half-up, matching bcdiv(seconds, 86400, 0) on-chain.
        const days     = mathjs.floor(mathjs.add(mathjs.divide(bn(secs), bn(86400)), bn(0.5)));
        const freeBn   = bn(Number(freeDays));
        const billable = days.gt(freeBn) ? mathjs.subtract(days, freeBn) : bn(0);
        const fee      = mathjs.multiply(mathjs.multiply(billable, bn(Number(perDay))), bn(String(gasPrice)));

        return {
            durationSeconds: secs,
            days:            Number(mathjs.format(days, { notation: 'fixed', precision: 0 })),
            billableDays:    Number(mathjs.format(billable, { notation: 'fixed', precision: 0 })),
            free:            !billable.gt(bn(0)),
            fee:             mathjs.format(fee, { notation: 'fixed', precision: 8 })
        };
    },

    actionIndex(value, field, ctx) {
        if (!isSet(value))
            fail('MISSING_REQUIRED_FIELD', `${ctx}: ${field} is required`, { field });
        const str = String(value).trim();
        if (!/^\d+$/.test(str))
            fail('INVALID_FIELD_VALUE', `${ctx}: ${field} must be a numeric ACTION_INDEX`, { field, value });
        return str;
    }
};
