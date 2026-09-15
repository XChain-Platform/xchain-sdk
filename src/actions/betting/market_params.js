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

const { BET_LIMITS, isSet, fail } = require('./bet_rules.js');

function validateMarketIdentity(owner, label, outcomes, tick, deadline, now, ctx) {
    if (!isSet(label)) fail('MISSING_REQUIRED_FIELD', `${ctx}: label is required`, { field: 'LABEL' });
    const labelStr = String(label);
    if (labelStr.length > BET_LIMITS.MAX_BET_LABEL_LENGTH)
        fail('INVALID_FIELD_VALUE',
            `${ctx}: label is ${labelStr.length} characters, max ${BET_LIMITS.MAX_BET_LABEL_LENGTH}`,
            { field: 'LABEL' });

    const outcomeList = owner.outcomeArray(outcomes, ctx);

    // Native coin is rejected at parse: stakes must be escrowable, and a
    // native-coin wager would need COINPAY-style obligation machinery.
    if (!isSet(tick))
        fail('MISSING_REQUIRED_FIELD',
            `${ctx}: tick is required. Betting is token-only; native coin (empty TICK) is not supported`,
            { field: 'TICK' });

    if (!isSet(deadline)) fail('MISSING_REQUIRED_FIELD', `${ctx}: deadline is required`, { field: 'DEADLINE' });
    const deadlineNum = Number(deadline);
    if (!Number.isInteger(deadlineNum) || deadlineNum <= 0)
        fail('INVALID_FIELD_VALUE', `${ctx}: deadline must be a positive integer Unix timestamp`, { field: 'DEADLINE', value: deadline });
    const nowSec = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
    if (deadlineNum <= nowSec)
        fail('INVALID_FIELD_VALUE',
            `${ctx}: deadline ${deadlineNum} is in the past (now ${nowSec}). Betting closes at the deadline, so it must be ahead of the block time`,
            { field: 'DEADLINE', value: deadlineNum });
    if (deadlineNum - nowSec > BET_LIMITS.MAX_BET_DEADLINE_HORIZON)
        fail('INVALID_FIELD_VALUE',
            `${ctx}: deadline is more than ${BET_LIMITS.MAX_BET_DEADLINE_HORIZON} seconds ahead, the protocol maximum`,
            { field: 'DEADLINE', value: deadlineNum });
    return { labelStr, outcomeList, deadlineNum };
}

function normalizeMarketAmounts(fee, refundWindow, minAmount, ctx) {
    let feeOut = '';
    if (isSet(fee)) {
        const feeStr = String(fee).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(feeStr))
            fail('INVALID_FIELD_VALUE',
                `${ctx}: fee must be a number with at most 2 decimal places. It is a PERCENT of the pot: 1.00 means 1%`,
                { field: 'FEE', value: fee });
        if (Number(feeStr) > BET_LIMITS.MAX_FEED_FEE)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: fee ${feeStr}% exceeds the maximum ${BET_LIMITS.MAX_FEED_FEE}%`,
                { field: 'FEE', value: feeStr, constraint: { max: BET_LIMITS.MAX_FEED_FEE } });
        feeOut = feeStr;
    }

    let refundOut = '';
    if (isSet(refundWindow)) {
        const rw = Number(refundWindow);
        if (!Number.isInteger(rw) || rw < BET_LIMITS.MIN_BET_REFUND_WINDOW || rw > BET_LIMITS.MAX_BET_REFUND_WINDOW)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: refundWindow must be an integer between ${BET_LIMITS.MIN_BET_REFUND_WINDOW} and ${BET_LIMITS.MAX_BET_REFUND_WINDOW} seconds`,
                { field: 'REFUND_WINDOW', value: refundWindow });
        refundOut = String(rw);
    }

    let minOut = '';
    if (isSet(minAmount)) {
        const min = String(minAmount).trim();
        if (!/^\d+(\.\d+)?$/.test(min) || Number(min) <= 0)
            fail('INVALID_FIELD_VALUE', `${ctx}: minAmount must be a positive amount`, { field: 'MIN_AMOUNT', value: minAmount });
        minOut = min;
    }
    return { feeOut, refundOut, minOut };
}

function normalizeMarketLists(owner, allowList, blockList, ctx) {
    const allowOut = isSet(allowList) ? owner._actionIndex(allowList, 'ALLOW_LIST', ctx) : '';
    const blockOut = isSet(blockList) ? owner._actionIndex(blockList, 'BLOCK_LIST', ctx) : '';
    if (allowOut !== '' && blockOut !== '' && allowOut === blockOut)
        fail('INVALID_FIELD_VALUE',
            `${ctx}: allowList and blockList are the same list (${allowOut}). Nobody could ever bet on that market`,
            { field: 'BLOCK_LIST', value: blockOut });
    return { allowOut, blockOut };
}

function encodeMarketDetails(owner, details, outcomeList, ctx) {
    if (details === undefined || details === null || details === '') return '';
    if (typeof details === 'object')
        return owner.buildBetDetails(details, { outcomes: outcomeList });

    // Already encoded: validate it, and cross-check any outcomes it
    // carries, so a hand-rolled DETAILS cannot silently disagree.
    const parsed = owner.parseBetDetails(details);
    if (parsed.outcomes !== undefined) {
        if (!Array.isArray(parsed.outcomes))
            fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS.outcomes must be an array when present`, { field: 'DETAILS' });
        const given = parsed.outcomes.map(o => String(o == null ? '' : o).trim());
        if (given.length !== outcomeList.length || given.some((o, i) => o !== outcomeList[i]))
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS.outcomes must match the OUTCOMES field exactly (same order, same count)`,
                { field: 'DETAILS', outcomes: outcomeList, details: given });
    }
    return String(details);
}

module.exports = {
    // Build BET v0 params (create a market).
    //
    // `details` may be a plain object (encoded here, and cross-checked against
    // `outcomes` so the two can never disagree) or an already-encoded base64
    // string (validated, and its outcomes cross-checked if it carries any).
    // `now` is injectable so deadline pre-flight is testable; it defaults to the
    // local clock, which approximates BLOCK_TIME closely enough for a warning.
    createMarketParams({
        label, outcomes, tick, fee, deadline, refundWindow, minAmount,
        allowList, blockList, details, memo, now
    } = {}) {
        const ctx = 'betting.createMarketParams';
        const { labelStr, outcomeList, deadlineNum } =
            validateMarketIdentity(this, label, outcomes, tick, deadline, now, ctx);
        const { feeOut, refundOut, minOut } = normalizeMarketAmounts(fee, refundWindow, minAmount, ctx);
        const { allowOut, blockOut } = normalizeMarketLists(this, allowList, blockList, ctx);
        const detailsOut = encodeMarketDetails(this, details, outcomeList, ctx);

        return {
            version:      0,
            label:        labelStr,
            outcomes:     outcomeList.join(','),
            tick:         String(tick),
            fee:          feeOut,
            deadline:     String(deadlineNum),
            refundWindow: refundOut,
            minAmount:    minOut,
            allowList:    allowOut,
            blockList:    blockOut,
            details:      detailsOut,
            memo:         isSet(memo) ? String(memo) : ''
        };
    },

    // Build BET v1 params (cancel a market). Owner-only on-chain.
    cancelMarketParams({ feedActionIndex, memo } = {}) {
        const ctx = 'betting.cancelMarketParams';
        return {
            version:         1,
            feedActionIndex: this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx),
            memo:            isSet(memo) ? String(memo) : ''
        };
    },

    // Build BET v2 params (place a bet).
    //
    // `outcome` is the ZERO-BASED index into the market's OUTCOMES, not a label.
    // Pass `outcomes` to resolve a label to its index and to range-check it.
    placeBetParams({ feedActionIndex, outcome, amount, outcomes, memo } = {}) {
        const ctx = 'betting.placeBetParams';
        const feed = this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx);

        const index = this.outcomeIndex(outcome, outcomes, ctx);

        if (!isSet(amount)) fail('MISSING_REQUIRED_FIELD', `${ctx}: amount is required`, { field: 'AMOUNT' });
        const amt = String(amount).trim();
        if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0)
            fail('INVALID_FIELD_VALUE', `${ctx}: amount must be a positive stake`, { field: 'AMOUNT', value: amount });

        return {
            version:         2,
            feedActionIndex: feed,
            outcome:         String(index),
            amount:          amt,
            memo:            isSet(memo) ? String(memo) : ''
        };
    },

    // Build BET v3 params (resolve a market to an outcome). Owner-only on-chain.
    resolveMarketParams({ feedActionIndex, outcome, outcomes, memo } = {}) {
        const ctx = 'betting.resolveMarketParams';
        return {
            version:         3,
            feedActionIndex: this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx),
            outcome:         String(this.outcomeIndex(outcome, outcomes, ctx)),
            memo:            isSet(memo) ? String(memo) : ''
        };
    },

    // Resolve an outcome to its wire index. Accepts the index itself, or a label
    // when the market's `outcomes` are supplied. Range-checked against the
    // market when known, because an out-of-range OUTCOME is rejected on-chain
    // after the fee is paid.
    outcomeIndex(outcome, outcomes, ctx = 'betting') {
        if (!isSet(outcome) && outcome !== 0)
            fail('MISSING_REQUIRED_FIELD', `${ctx}: outcome is required`, { field: 'OUTCOME' });

        const list = outcomes === undefined ? null : this.outcomeArray(outcomes, ctx);

        // A label is only accepted when the market's outcomes are known. A
        // numeric string is always read as an index: outcome labels that look
        // like numbers ("0", "1") are legal, so guessing would be ambiguous.
        if (!/^\d+$/.test(String(outcome).trim())) {
            if (!list)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${outcome}" is not an index. Pass the market's outcomes to resolve a label`,
                    { field: 'OUTCOME', value: outcome });
            const found = list.indexOf(String(outcome).trim());
            if (found === -1)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${outcome}" is not one of ${JSON.stringify(list)}`,
                    { field: 'OUTCOME', value: outcome });
            return found;
        }

        const index = Number(String(outcome).trim());
        if (list && index >= list.length)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: outcome index ${index} is out of range for ${list.length} outcomes (0..${list.length - 1})`,
                { field: 'OUTCOME', value: index, constraint: { max: list.length - 1 } });
        return index;
    }
};
