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
 * hardening.js and _harden() below.
 *
 ********************************************************************/

'use strict';

const { str, toArray } = require('./value_format.js');

/*
 * LIST describer. Two format versions:
 *   - v0 Create: VERSION|TYPE|ITEM (ITEM repeats). TYPE 1 = TICK list,
 *     TYPE 2 = ADDRESS list.
 *   - v1 Edit: VERSION|EDIT|LIST_ACTION_INDEX|ITEM (ITEM repeats).
 *     Clones an existing list and adds (EDIT=1) or removes (EDIT=2).
 */
function decodeList(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const items = toArray(p.ITEM);
    const count = items.length;

    if (version === '1') {
        const edit = str(p.EDIT);
        const parent = str(p.LIST_ACTION_INDEX);
        const verb = edit === '1' ? 'Add' : edit === '2' ? 'Remove' : 'Edit';
        const prep = edit === '2' ? 'from' : 'to';
        const summary = `${verb} ${count || '?'} item${count === 1 ? '' : 's'} ${prep} list${parent ? ` #${parent}` : ''}${chainSuffix}`;
        return {
            summary,
            details: [
                { label: 'Edit', value: edit === '1' ? 'Add' : edit === '2' ? 'Remove' : edit },
                ...(parent ? [{ label: 'Parent list action index', value: parent }] : []),
                { label: 'Items', value: String(count) },
                ...(count > 0 && count <= 5
                    ? [{ label: 'Sample', value: items.join(', ') }]
                    : []),
            ],
            warnings: [
                ...(!edit ? ['Edit direction is empty. Specify whether to add or remove items.'] : []),
                ...(!parent ? ['Parent list action index is empty.'] : []),
                ...(count === 0 ? ['List has no items.'] : []),
            ],
        };
    }

    // Version 0: create.
    const type = str(p.TYPE);
    const kind = type === '1' ? 'token' : type === '2' ? 'address' : 'item';
    const summary = `Create ${kind} list of ${count || '?'} item${count === 1 ? '' : 's'}${chainSuffix}`;
    return {
        summary,
        details: [
            { label: 'Type', value: type === '1' ? 'Token' : type === '2' ? 'Address' : type },
            { label: 'Items', value: String(count) },
            ...(count > 0 && count <= 5
                ? [{ label: 'Sample', value: items.join(', ') }]
                : []),
        ],
        warnings: [
            ...(!type ? ['List type is empty. Specify a token list or an address list.'] : []),
            ...(count === 0 ? ['List has no items.'] : []),
        ],
    };
}

/*
 * AIRDROP describer. Four format versions: v0 single; v1 multi-token
 * single-list; v2 multi-token multi-list; v3 = v2 + per-tuple MEMO.
 * The describer cannot know whether the referenced LIST is a TICK
 * list or an ADDRESS list without a DB lookup, so summaries stay
 * neutral.
 */
function decodeAirdrop(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const memo = Array.isArray(p.MEMO) ? '' : str(p.MEMO);
    const memoArr = toArray(p.MEMO);
    const memoWarning = memo && /[|;]/.test(memo)
        ? ['Memo contains | or ;: the protocol will reject this transaction.']
        : memoArr.some((m) => /[|;]/.test(String(m)))
            ? ['A memo contains | or ;: the protocol will reject this transaction.']
            : [];

    if (version === '0' && !Array.isArray(p.TICK)) {
        const tick = str(p.TICK);
        const amount = str(p.AMOUNT);
        const listIdx = str(p.LIST_ACTION_INDEX);
        return {
            summary: `Airdrop ${amount || '?'} ${tick || '?'}${chainSuffix} to list${listIdx ? ` #${listIdx}` : ''}`,
            details: [
                { label: 'Token', value: tick },
                { label: 'Per-recipient amount', value: amount },
                { label: 'List action index', value: listIdx ? `#${listIdx}` : '' },
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!tick ? ['Token ticker is empty.'] : []),
                ...(!amount || Number(amount) <= 0
                    ? ['Per-recipient amount is not positive.']
                    : []),
                ...(!listIdx ? ['List action index is empty.'] : []),
                ...memoWarning,
            ],
        };
    }

    // Multi-airdrop variants (v1 / v2 / v3). Fields arrive as arrays
    // when the format repeats slots.
    const ticks = toArray(p.TICK);
    const amounts = toArray(p.AMOUNT);
    const lists = toArray(p.LIST_ACTION_INDEX);
    const n = Math.max(ticks.length, amounts.length, 1);

    const drops = [];
    for (let i = 0; i < n; i += 1) {
        const t = str(ticks[i] !== undefined ? ticks[i] : '');
        const a = str(amounts[i] !== undefined ? amounts[i] : '');
        // v1 reuses a single LIST_ACTION_INDEX across all TICK/AMOUNT
        // pairs; v2/v3 carry one per tuple.
        const li = version === '1'
            ? str(lists[0] !== undefined ? lists[0] : '')
            : str(lists[i] !== undefined ? lists[i] : '');
        const m = version === '3' ? str(memoArr[i] !== undefined ? memoArr[i] : '') : '';
        drops.push({ tick: t, amount: a, list: li, memo: m });
    }

    const summaryLine = drops
        .map((d) => `${d.amount || '?'} ${d.tick || '?'} → list${d.list ? ` #${d.list}` : ''}`)
        .join(', ');
    const summary = `Airdrop${chainSuffix}: ${summaryLine}`;

    const details = drops.flatMap((d, i) => [
        { label: `Drop ${i + 1}`, value: `${d.amount || '?'} ${d.tick || '?'} to list${d.list ? ` #${d.list}` : ''}` },
        ...(d.memo ? [{ label: `  Memo`, value: d.memo }] : []),
    ]);
    if (memo && version !== '3') details.push({ label: 'Memo', value: memo });

    const warnings = [
        ...(drops.some((d) => !d.tick) ? ['One or more token tickers are empty.'] : []),
        ...(drops.some((d) => !d.amount || Number(d.amount) <= 0)
            ? ['One or more per-recipient amounts are not positive.']
            : []),
        ...(drops.some((d) => !d.list) ? ['One or more list action indexes are empty.'] : []),
        ...memoWarning,
    ];

    return { summary, details, warnings };
}

/*
 * DIVIDEND describer. Single format `VERSION|TICK|DIVIDEND_TICK|
 * AMOUNT|MEMO`: pays AMOUNT of DIVIDEND_TICK per unit of TICK held at
 * the snapshot block; the source address is excluded from receiving.
 */
function decodeDividend(p, chainSuffix) {
    const tick = str(p.TICK);
    const dividendTick = str(p.DIVIDEND_TICK);
    const amount = str(p.AMOUNT);
    const memo = str(p.MEMO);
    return {
        summary: `Pay ${amount || '?'} ${dividendTick || '?'} per unit of ${tick || '?'}${chainSuffix}`,
        details: [
            { label: 'Holders of', value: tick },
            { label: 'Receive', value: dividendTick },
            { label: 'Per-unit amount', value: amount },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!tick ? ['Holder ticker is empty.'] : []),
            ...(!dividendTick ? ['Dividend ticker is empty.'] : []),
            ...(!amount || Number(amount) <= 0
                ? ['Per-unit amount is not positive.']
                : []),
            ...(memo && /[|;]/.test(memo)
                ? ['Memo contains | or ;: the protocol will reject this transaction.']
                : []),
        ],
    };
}

/*
 * DISPENSER describer. v0 create (coin-paid, token-paid, or
 * fiat/oracle-priced lanes), v1 cancel, v2 edit.
 */
function decodeDispenser(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const memo = str(p.MEMO);
    const baseWarnings = [
        ...(memo && /[|;]/.test(memo)
            ? ['Memo contains | or ;: the protocol will reject this transaction.']
            : []),
    ];

    if (version === '1') {
        const idx = str(p.DISPENSER_ACTION_INDEX);
        return {
            summary: `Cancel dispenser${chainSuffix}${idx ? ` (#${idx})` : ''}`,
            details: [
                ...(idx ? [{ label: 'Dispenser action index', value: idx }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                'Cancelling a dispenser returns the remaining escrow to the owner after a 1-hour close window.',
                ...(!idx ? ['Dispenser action index is empty.'] : []),
                ...baseWarnings,
            ],
        };
    }

    if (version === '2') {
        const idx = str(p.DISPENSER_ACTION_INDEX);
        const giveEscrow = str(p.GIVE_ESCROW);
        const expiration = str(p.EXPIRATION);
        const allowList = str(p.ALLOW_LIST);
        const blockList = str(p.BLOCK_LIST);
        return {
            summary: `Edit dispenser${chainSuffix}${idx ? ` (#${idx})` : ''}`,
            details: [
                ...(idx ? [{ label: 'Dispenser action index', value: idx }] : []),
                ...(giveEscrow ? [{ label: 'Refill escrow by', value: giveEscrow }] : []),
                ...(expiration ? [{ label: 'Expiration (unix)', value: expiration }] : []),
                ...(allowList ? [{ label: 'Allow list', value: allowList }] : []),
                ...(blockList ? [{ label: 'Block list', value: blockList }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!idx ? ['Dispenser action index is empty.'] : []),
                'Allow/block list changes take effect after a 1-hour delay.',
                ...baseWarnings,
            ],
        };
    }

    // Version 0: create.
    const giveCoin = str(p.GIVE_COIN);
    const giveTick = str(p.GIVE_TICK);
    const giveAmount = str(p.GIVE_AMOUNT);
    const giveEscrow = str(p.GIVE_ESCROW);
    const getCoin = str(p.GET_COIN);
    const getTick = str(p.GET_TICK);
    const getAmount = str(p.GET_AMOUNT);
    const getAddress = str(p.GET_ADDRESS);
    const fiatCode = str(p.FIAT_CODE);
    const fiatAmount = str(p.FIAT_AMOUNT);
    const oracle = str(p.ORACLE_ADDRESS);
    const expiration = str(p.EXPIRATION);
    const allowList = str(p.ALLOW_LIST);
    const blockList = str(p.BLOCK_LIST);

    const payPriceLabel = oracle
        ? `an oracle-priced ${fiatCode || 'fiat'} amount`
        : fiatAmount && fiatCode
            ? `${fiatAmount} ${fiatCode}`
            : getTick
                ? `${getAmount || '?'} ${getTick}`
                : `${getAmount || '?'} ${getCoin || '?'}`;

    const fillsEstimate = giveAmount && giveEscrow && Number(giveAmount) > 0
        ? Math.floor(Number(giveEscrow) / Number(giveAmount))
        : null;

    const summary = `Create dispenser${chainSuffix}: lock ${giveEscrow || '?'} ${giveTick || '?'}, give ${giveAmount || '?'} ${giveTick || '?'} per ${payPriceLabel}`;

    const details = [
        { label: 'Token (give)', value: giveTick },
        ...(giveCoin ? [{ label: 'Token chain', value: giveCoin }] : []),
        ...(giveAmount ? [{ label: 'Per-fill amount', value: giveAmount }] : []),
        ...(giveEscrow ? [{ label: 'Escrow (locked)', value: giveEscrow }] : []),
        ...(fillsEstimate !== null ? [{ label: 'Estimated fills', value: String(fillsEstimate) }] : []),
        ...(getAmount ? [{ label: 'Trigger amount', value: getAmount }] : []),
        ...(getTick ? [{ label: 'Buyer pays (token)', value: getTick }] : []),
        ...(!getTick && getCoin ? [{ label: 'Buyer pays (coin)', value: getCoin }] : []),
        ...(fiatCode ? [{ label: 'Priced in', value: fiatCode }] : []),
        ...(fiatAmount ? [{ label: 'Fiat amount', value: fiatAmount }] : []),
        ...(oracle ? [{ label: 'Oracle address', value: oracle }] : []),
        ...(getAddress ? [{ label: 'Dispenser address', value: getAddress }] : []),
        ...(expiration ? [{ label: 'Expiration (unix)', value: expiration }] : []),
        ...(allowList ? [{ label: 'Allow list', value: allowList }] : []),
        ...(blockList ? [{ label: 'Block list', value: blockList }] : []),
        ...(memo ? [{ label: 'Memo', value: memo }] : []),
    ];

    const warnings = [
        ...(!giveTick ? ['Give-token ticker is empty.'] : []),
        ...(!giveAmount || Number(giveAmount) <= 0
            ? ['Per-fill amount is not positive.']
            : []),
        ...(!giveEscrow || Number(giveEscrow) <= 0
            ? ['Escrow amount is not positive.']
            : []),
        ...(giveAmount && giveEscrow && Number(giveEscrow) < Number(giveAmount)
            ? ['Escrow is smaller than a single fill, so the dispenser will never dispense.']
            : []),
        ...(!getAmount ? ['Trigger amount is empty.'] : []),
        ...(!getTick && !getCoin
            ? ['Buyer payment is ambiguous. Set either a token or a coin for the buyer to pay.']
            : []),
        ...(oracle && !fiatCode
            ? ['Oracle pricing requires a fiat currency. The oracle publishes token prices in that fiat.']
            : []),
        ...baseWarnings,
    ];

    return { summary, details, warnings };
}

module.exports = { decodeList, decodeAirdrop, decodeDividend, decodeDispenser };
