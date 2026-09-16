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
 * XChain Platform SDK - decoder.describe
 *
 * Plain-English action describer, promoted from the wallet
 * (packages/core/src/decoder/actionDecoder.js). Pure
 * function (no vault, no network); both wallet shells and any SDK
 * consumer render the same {summary, details, warnings} contract.
 *
 * Dedicated describers: ADDRESS, SEND, SWEEP, ISSUE (v0-v7), MINT,
 * DESTROY, BATCH, BROADCAST, DISPENSER, DIVIDEND, LIST, AIRDROP, ORDER,
 * SWAP, STAKE, UNSTAKE, DELEGATE, VOTE, DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW, COINPAY, COLLECT, MESSAGE, FILE, LINK, SLEEP, CALLBACK,
 * PRICE, BET, XBRIDGE - i.e. every ACTION in formats.js, which
 * `test/unit/decoder/describe.test.js` enumerates rather than trusting
 * this list: the confirm screen is where a user verifies intent
 * before signing, so a missing case there is a coverage hole on the
 * security surface, not a cosmetic gap.
 *
 * A future action added to formats.js with no case here gets the generic
 * fallback (which still names the action and lists every parameter) and
 * fails that enumeration test. Untrusted-input hardening (bidi/zero-width
 * neutralization, canonical amount flags, own-address/contact
 * marking) is applied centrally to the finished output - see
 * hardening.js and harden() below.
 *
 ********************************************************************/

'use strict';

const { getCoinLabel, str } = require('./value_format.js');

/*
 * ORDER / SWAP describer. v0 create, v1 cancel, v2 edit. The two
 * actions share a wire shape; SWAP settles atomically on match while
 * ORDER creates a match obligation settled by COINPAY.
 */
function decodeOrderSwap(action, p, chainSuffix) {
    const noun = action === 'SWAP' ? 'swap' : 'order';
    const version = str(p.VERSION) || '0';
    const memo = str(p.MEMO);
    const idxField = action === 'SWAP' ? 'SWAP_ACTION_INDEX' : 'ORDER_ACTION_INDEX';
    const idx = str(p[idxField]);
    const memoWarnings = memo && /[|;]/.test(memo)
        ? ['Memo contains | or ;: the protocol will reject this transaction.'] : [];

    if (version === '1') return decodeOrderCancel(action, noun, chainSuffix, idx, memo, memoWarnings);
    if (version === '2') return decodeOrderEdit(action, p, noun, chainSuffix, idx, memo, memoWarnings);
    return decodeOrderCreate(p, noun, chainSuffix, memo, memoWarnings);
}

function decodeOrderCancel(action, noun, chainSuffix, idx, memo, memoWarnings) {
    return {
        summary: `Cancel ${noun}${chainSuffix}${idx ? ` (#${idx})` : ''}`,
        details: [
            ...(idx ? [{ label: `${action === 'SWAP' ? 'Swap' : 'Order'} action index`, value: idx }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [...(!idx ? [`${action === 'SWAP' ? 'Swap' : 'Order'} action index is empty.`] : []), ...memoWarnings],
    };
}

function decodeOrderEdit(action, p, noun, chainSuffix, idx, memo, memoWarnings) {
    const expiration = str(p.EXPIRATION);
    const allowList = str(p.ALLOW_LIST);
    const blockList = str(p.BLOCK_LIST);
    return {
        summary: `Edit ${noun}${chainSuffix}${idx ? ` (#${idx})` : ''}`,
        details: [
            ...(idx ? [{ label: `${action === 'SWAP' ? 'Swap' : 'Order'} action index`, value: idx }] : []),
            ...(expiration ? [{ label: 'Expiration', value: expiration }] : []),
            ...(allowList ? [{ label: 'Allow list', value: allowList }] : []),
            ...(blockList ? [{ label: 'Block list', value: blockList }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [...(!idx ? [`${action === 'SWAP' ? 'Swap' : 'Order'} action index is empty.`] : []), ...memoWarnings],
    };
}

function decodeOrderCreate(p, noun, chainSuffix, memo, memoWarnings) {
    // v0 create.
    const giveTick = str(p.GIVE_TICK);
    const giveCoin = str(p.GIVE_COIN);
    const giveAmount = str(p.GIVE_AMOUNT);
    const giveOwnership = str(p.GIVE_OWNERSHIP) === '1';
    const getTick = str(p.GET_TICK);
    const getCoin = str(p.GET_COIN);
    const getAmount = str(p.GET_AMOUNT);
    const getOwnership = str(p.GET_OWNERSHIP) === '1';
    const getAddress = str(p.GET_ADDRESS);
    const expiration = str(p.EXPIRATION);
    const giveLabel = giveOwnership
        ? `ownership of ${giveTick || '?'}`
        : `${giveAmount || '?'} ${giveTick || getCoinLabel(giveCoin) || '?'}`;
    const getLabel = getOwnership
        ? `ownership of ${getTick || '?'}`
        : `${getAmount || '?'} ${getTick || getCoinLabel(getCoin) || '?'}`;
    return {
        summary: `Create ${noun}${chainSuffix}: give ${giveLabel} for ${getLabel}`,
        details: [
            { label: 'Give', value: giveLabel },
            { label: 'Get', value: getLabel },
            ...(getAddress ? [{ label: 'Counterparty', value: getAddress }] : []),
            ...(expiration ? [{ label: 'Expiration', value: expiration }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!giveOwnership && (!giveAmount || Number(giveAmount) <= 0)
                ? ['Give amount is not positive.'] : []),
            ...(!getOwnership && (!getAmount || Number(getAmount) <= 0)
                ? ['Get amount is not positive.'] : []),
            ...memoWarnings,
        ],
    };
}

/* COINPAY describer: settle a matched order with native coin. */
function decodeCoinpay(p, chainSuffix) {
    const idx = str(p.ORDER_MATCH_ACTION_INDEX);
    return {
        summary: `Pay native coin to settle order match${idx ? ` #${idx}` : ''}${chainSuffix}`,
        details: [{ label: 'Order match', value: idx ? `#${idx}` : '' }],
        warnings: [
            ...(!idx ? ['Order match action index is empty.'] : []),
            'This transaction moves native coin to the order counterparty.',
        ],
    };
}

/*
 * PRICE describer (wallet PC-30 version, promoted here).
 * PRICE.md defines two versions and only one of them is authorable: v0
 * is the validator federation's COIN/FIAT snapshot, PBFT-broadcast and
 * not user-encodable, so a v0 reaching this describer came from a
 * pasted or imported action and is flagged rather than summarized as
 * something the user can sign.
 *
 * v1 is the permissionless user oracle: VERSION|COIN|TICK|FIAT|VALUE|FEE|MEMO.
 * Two warnings ride on every v1 because they are the two things that
 * surprise publishers, and both are properties of the protocol rather
 * than of this particular publish: the quote is inert for 24h and
 * cannot be retracted in that window, and dispensers pointing at this
 * address will settle real money against it.
 *
 * Not the legacy BROADCAST v1/v2 "oracle" lane, which is a free-text
 * feed with a percentage fee. They share the word and nothing else:
 * only a PRICE v1 row can price a Mode B dispenser.
 */
function decodePrice(p, chainSuffix) {
    const version = str(p.VERSION) || '1';
    const coin = str(p.COIN).toUpperCase();
    const tick = str(p.TICK).toUpperCase();
    const fiat = str(p.FIAT).toUpperCase();
    const value = str(p.VALUE);
    const fee = str(p.FEE);
    const memo = str(p.MEMO);

    if (version === '0') {
        return {
            summary: `Validator price snapshot${chainSuffix}`,
            details: [
                ...(coin ? [{ label: 'Coin', value: coin }] : []),
                ...(fiat ? [{ label: 'Currency', value: fiat }] : []),
                ...(value ? [{ label: 'Value', value }] : []),
            ],
            warnings: [
                'PRICE v0 is published by the validator federation, not by a wallet. The network will reject this transaction.',
            ],
        };
    }

    // FEE is a fraction on the wire (0.01 = 1%); show both so a publisher
    // who typed one and meant the other notices before signing.
    const feePct = fee && Number.isFinite(Number(fee))
        ? `${fee} (${(Number(fee) * 100).toFixed(2).replace(/\.?0+$/, '')}% of a dispenser's projected proceeds)`
        : fee;

    return {
        summary: `Publish oracle price 1 ${tick || '?'} = ${value || '?'} ${fiat || '?'}${chainSuffix}`,
        details: [
            { label: 'Token', value: coin && tick ? `${coin}:${tick}` : tick },
            { label: 'Currency', value: fiat },
            // Bare number, with the currency on its own row above: the
            // hardening pass amount-checks any "per unit" label, and a
            // "1.5 USD" value would be flagged as not-a-plain-decimal.
            { label: 'Price per unit', value },
            ...(fee ? [{ label: 'Oracle usage fee', value: feePct }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'This price takes effect 24 hours from now and cannot be changed or withdrawn before then. A correction is another publish, which also takes 24 hours.',
            'Dispensers that name this address as their oracle will sell at this price once it takes effect.',
            ...(!tick ? ['Token ticker is empty.'] : []),
            ...(!fiat ? ['Currency is empty.'] : []),
            ...(!value || Number(value) <= 0 ? ['Price is not a positive number.'] : []),
            ...(fee && Number(fee) > 1
                ? ['Oracle usage fee is above 1 (100%): the protocol will reject this transaction.']
                : []),
            ...(memo && /[|;]/.test(memo)
                ? ['Memo contains | or ;: the protocol will reject this transaction.']
                : []),
        ],
    };
}

/*
 * BET describer (§11.3 signing, promoted from the wallet). One action
 * name over four formats, so the summary must name
 * WHICH one is being signed: approving a resolve is not remotely the
 * same act as approving a stake.
 *
 * Reads the wire spelling a ParsedAction carries, and tolerates the SDK
 * builder's camelCase output so a caller describing what it just built
 * (rather than what it parsed) still reads sensibly.
 *
 * The warnings are the irreversibilities, not lint. A bet cannot be
 * cancelled, a resolve is the payout decision itself, and a cancel
 * refunds and ends the market. Those are the facts a signer needs
 * before approving, and exactly what a raw-hex screen would hide.
 */
function decodeBet(p, chainSuffix) {
    const pick = (camel, upper) => {
        const a = p[camel];
        if (a !== undefined && a !== null && a !== '') return str(a);
        const b = p[upper];
        return (b === undefined || b === null) ? '' : str(b);
    };

    const version = pick('version', 'VERSION');
    const feedRef = pick('feedActionIndex', 'FEED_ACTION_INDEX');
    const outcome = pick('outcome', 'OUTCOME');
    const memo = pick('memo', 'MEMO');
    const memoWarn = memo && /[|;]/.test(memo)
        ? ['Memo contains | or ;: the protocol will reject this transaction.']
        : [];

    if (version === '2') return decodeBetPlacement(chainSuffix, pick, feedRef, outcome, memo, memoWarn);
    if (version === '3') return decodeBetResolution(chainSuffix, feedRef, outcome, memo, memoWarn);
    if (version === '1') return decodeBetCancellation(chainSuffix, feedRef, memo, memoWarn);
    return decodeBetMarket(chainSuffix, pick, memo, memoWarn);
}

function decodeBetPlacement(chainSuffix, pick, feedRef, outcome, memo, memoWarn) {
    // v2 place a bet
    const amount = pick('amount', 'AMOUNT');
    return {
        summary: `Bet ${amount || '?'} on outcome ${outcome || '?'} of market ${feedRef || '?'}${chainSuffix}`,
        details: [
            { label: 'Market', value: feedRef },
            { label: 'Outcome', value: outcome },
            { label: 'Stake', value: amount },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'Bets are final. There is no cancel and no way to change your outcome once this is signed.',
            'This is a parimutuel market, so your share is not fixed now: later bets change what a win pays.',
            ...(!amount || Number(amount) <= 0 ? ['Stake is not positive.'] : []),
            ...memoWarn,
        ],
    };
}

function decodeBetResolution(chainSuffix, feedRef, outcome, memo, memoWarn) {
    // v3 resolve a market
    return {
        summary: `Resolve market ${feedRef || '?'} to outcome ${outcome || '?'}${chainSuffix}`,
        details: [
            { label: 'Market', value: feedRef },
            { label: 'Winning outcome', value: outcome },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'This pays out the market. Everyone backing this outcome splits the pot, everyone else loses their stake.',
            'Resolving cannot be undone or corrected afterwards.',
            ...memoWarn,
        ],
    };
}

function decodeBetCancellation(chainSuffix, feedRef, memo, memoWarn) {
    // v1 cancel a market
    return {
        summary: `Cancel market ${feedRef || '?'} and refund every bet${chainSuffix}`,
        details: [
            { label: 'Market', value: feedRef },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'Every open bet is refunded in full and the market is over. This cannot be undone.',
            ...memoWarn,
        ],
    };
}

function decodeBetMarket(chainSuffix, pick, memo, memoWarn) {
    // v0 create a market (also the fallback when VERSION is absent, since the
    // create format is the only one carrying a label).
    const label = pick('label', 'LABEL');
    const outcomes = pick('outcomes', 'OUTCOMES');
    const tick = pick('tick', 'TICK');
    const fee = pick('fee', 'FEE');
    const deadline = pick('deadline', 'DEADLINE');
    const refundWindow = pick('refundWindow', 'REFUND_WINDOW');
    const minAmount = pick('minAmount', 'MIN_AMOUNT');
    const allowList = pick('allowList', 'ALLOW_LIST');
    const blockList = pick('blockList', 'BLOCK_LIST');
    const outcomeList = outcomes ? outcomes.split(',') : [];

    return {
        summary: `Open a betting market on ${tick || '?'}${chainSuffix}: ${label || '(untitled)'}`,
        details: [
            { label: 'Market', value: label },
            { label: 'Outcomes', value: outcomeList.join(' / ') },
            { label: 'Wager token', value: tick },
            // Named to keep it distinct from the protocol's market duration fee,
            // which is a different charge paid to a different party.
            { label: 'Oracle fee (percent of pot)', value: fee ? `${fee}%` : '0%' },
            { label: 'Betting closes', value: deadline },
            { label: 'Refund window (seconds)', value: refundWindow },
            ...(minAmount ? [{ label: 'Minimum bet', value: minAmount }] : []),
            ...(allowList ? [{ label: 'Allow list', value: allowList }] : []),
            ...(blockList ? [{ label: 'Block list', value: blockList }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'Markets cannot be edited after this. To change any term you must cancel and create a new one.',
            'You are the oracle: if you never resolve it, bettors are refunded after the refund window, and your address carries that record publicly.',
            ...(outcomeList.length < 2 ? ['A market needs at least two outcomes.'] : []),
            ...memoWarn,
        ],
    };
}

module.exports = { decodeOrderSwap, decodeCoinpay, decodePrice, decodeBet };
