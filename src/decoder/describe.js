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
 * (packages/core/src/decoder/actionDecoder.js) per . Pure
 * function (no vault, no network); both wallet shells and any SDK
 * consumer render the same {summary, details, warnings} contract.
 *
 * Dedicated describers: SEND, SWEEP, ISSUE (v0-v6), MINT, DESTROY,
 * BATCH, BROADCAST, DISPENSER, DIVIDEND, LIST, AIRDROP, ORDER, SWAP,
 * STAKE, UNSTAKE, DELEGATE, VOTE, DEPLOY, EXECUTE, DEPOSIT, WITHDRAW,
 * COINPAY, COLLECT, MESSAGE, FILE, LINK, SLEEP, CALLBACK, PRICE, BET.
 * Everything else gets the generic fallback (which still names the
 * action and lists every parameter). Untrusted-input hardening (bidi/zero-width
 * neutralization, canonical amount flags, own-address/contact
 * marking) is applied centrally to the finished output - see
 * hardening.js and _harden() below.
 *
 ********************************************************************/

'use strict';

const { actionDisplayLabel } = require('./actionDisplayLabel.js');
const { sanitizeText, formatAmount } = require('./hardening.js');

/*
 * @param {object} parsed  a ParsedAction from decoder.parse(), or a
 *                 legacy `{ action, params | fields }` object (the
 *                 wallet shim path; `fields` is createAction()'s name
 *                 for the same map)
 * @param {object} [ctx]
 * @param {string} [ctx.chainId]
 * @param {object} [ctx.chainRegistry]   has get(chainId) -> { displayName }
 * @param {string[]} [ctx.ownAddresses]  wallet-owned addresses; matching
 *                 destinations are marked "(your address)"
 * @param {object} [ctx.contacts]        { address: name } map; matches
 *                 are marked "(contact: name)"
 * @param {object} [ctx.tokenDecimals]   { TICK: decimals } map; when
 *                 supplied, amount precision is verified against it
 *                 (absent = precision checks are skipped, junk and
 *                 exponential notation are still flagged)
 * @returns {{ summary:string, details:Array<{label:string,value:string}>, warnings:string[] }}
 */
function describe(parsed, ctx = {}) {
    const action = parsed && parsed.action ? String(parsed.action) : '';
    const p = { ...((parsed && (parsed.params || parsed.fields)) || {}) };
    // ParsedAction carries the version top-level (parse() excludes
    // VERSION from params); versioned describers read p.VERSION.
    if (parsed && parsed.version !== undefined && parsed.version !== null && p.VERSION === undefined)
        p.VERSION = String(parsed.version);
    const { chainId, chainRegistry } = ctx;
    const descriptor = chainRegistry && chainId ? chainRegistry.get(chainId) : null;
    const chainName = (descriptor && descriptor.displayName) || chainId || '';
    const chainSuffix = chainName ? ` on ${chainName}` : '';

    let decoded;
    if (action === 'SEND') decoded = decodeSend(p, chainSuffix);
    else if (action === 'SWEEP') decoded = decodeSweep(p, chainSuffix);
    else if (action === 'ISSUE') decoded = decodeIssue(p, chainSuffix);
    else if (action === 'MINT') decoded = decodeMint(p, chainSuffix);
    else if (action === 'DESTROY') decoded = decodeDestroy(p, chainSuffix);
    else if (action === 'BATCH') decoded = decodeBatch(parsed, p, ctx, chainSuffix);
    else if (action === 'BROADCAST') decoded = decodeBroadcast(p, chainSuffix);
    else if (action === 'DISPENSER') decoded = decodeDispenser(p, chainSuffix);
    else if (action === 'DIVIDEND') decoded = decodeDividend(p, chainSuffix);
    else if (action === 'LIST') decoded = decodeList(p, chainSuffix);
    else if (action === 'AIRDROP') decoded = decodeAirdrop(p, chainSuffix);
    else if (action === 'ORDER' || action === 'SWAP') decoded = decodeOrderSwap(action, p, chainSuffix);
    else if (action === 'STAKE') decoded = decodeStake(p, chainSuffix);
    else if (action === 'UNSTAKE') decoded = decodeUnstake(p, chainSuffix);
    else if (action === 'DELEGATE') decoded = decodeDelegate(p, chainSuffix);
    else if (action === 'VOTE') decoded = decodeVote(p, chainSuffix);
    else if (action === 'DEPLOY') decoded = decodeDeploy(p, chainSuffix);
    else if (action === 'EXECUTE') decoded = decodeExecute(p, chainSuffix);
    else if (action === 'DEPOSIT' || action === 'WITHDRAW') decoded = decodeContractFunds(action, p, chainSuffix);
    else if (action === 'COINPAY') decoded = decodeCoinpay(p, chainSuffix);
    else if (action === 'COLLECT') decoded = decodeCollect(p, chainSuffix);
    else if (action === 'MESSAGE') decoded = decodeMessage(p, chainSuffix);
    else if (action === 'FILE') decoded = decodeFile(p, chainSuffix);
    else if (action === 'LINK') decoded = decodeLink(p, chainSuffix);
    else if (action === 'SLEEP') decoded = decodeSleep(p, chainSuffix);
    else if (action === 'CALLBACK') decoded = decodeCallback(p, chainSuffix);
    else if (action === 'PRICE') decoded = decodePrice(p, chainSuffix);
    else if (action === 'BET') decoded = decodeBet(p, chainSuffix);
    else decoded = genericFallback(action, p, chainSuffix);

    return _harden(decoded, p, ctx);
}

/*
 * Central display hardening: sanitize every rendered string, flag
 * suspicious amounts, and mark known destinations. Runs on the
 * finished DecodedAction so every describer (including the generic
 * fallback and future additions) is covered by construction.
 */
function _harden(decoded, p, ctx) {
    const warnings = [];
    const summary = sanitizeText(decoded.summary, warnings);

    const own = Array.isArray(ctx.ownAddresses) ? new Set(ctx.ownAddresses) : null;
    const contacts = ctx.contacts && typeof ctx.contacts === 'object' ? ctx.contacts : null;
    const decimalsMap = ctx.tokenDecimals && typeof ctx.tokenDecimals === 'object' ? ctx.tokenDecimals : null;
    const primaryTick = typeof p.TICK === 'string' ? p.TICK : null;

    const details = decoded.details.map(({ label, value }) => {
        let v = sanitizeText(value, warnings);
        if (/amount|supply|escrow|per unit/i.test(label) && v !== '') {
            // No tokenDecimals map supplied => NaN sentinel: formatAmount
            // skips both precision comparisons (frac > NaN is false) but
            // still flags junk and exponential notation. Multi-leg values
            // arrive ', '-joined; format each leg.
            const decimals = decimalsMap
                ? (primaryTick && decimalsMap[primaryTick] !== undefined ? decimalsMap[primaryTick] : null)
                : NaN;
            v = v.split(', ').map(part => formatAmount(part, decimals, warnings)).join(', ');
        }
        if ((own || contacts) && /destination|address|transfer ownership to/i.test(label) && v !== '') {
            if (own && own.has(v)) v = v + ' (your address)';
            else if (contacts && typeof contacts[v] === 'string') v = v + ' (contact: ' + sanitizeText(contacts[v]) + ')';
        }
        return { label, value: v };
    });

    // Describer warnings sanitized too (they may quote raw input).
    for (const w of decoded.warnings) warnings.push(sanitizeText(w));

    // _harden flags surface FIRST (tamper indicators outrank per-field
    // advisories), deduplicated.
    const merged = [...new Set(warnings)];
    return { summary, details, warnings: merged };
}

/* ------------------------------------------------------------------ *
 *  Per-action describers (ported verbatim from the wallet decoder,
 *  CommonJS-ified; behavior changes are limited to BATCH consuming
 *  ParsedAction.commands and the hardening pass above).
 * ------------------------------------------------------------------ */

function decodeSend(p, chainSuffix) {
    const tick = str(p.TICK);
    const amount = str(p.AMOUNT);
    const dest = str(p.DESTINATION);
    const memo = str(p.MEMO);
    return {
        summary: `Send ${firstStr(amount) || '?'} ${firstStr(tick) || '?'}${chainSuffix} to ${firstStr(dest) || '?'}`,
        details: [
            { label: 'Token', value: tick },
            { label: 'Amount', value: amount },
            { label: 'Destination', value: dest },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(memo && /[|;]/.test(memo)
                ? ['Memo contains | or ;: the protocol will reject this transaction.']
                : []),
            ...(!amount || Number(firstStr(amount)) <= 0
                ? ['Amount is not positive.']
                : []),
            ...(!dest ? ['Destination is empty.'] : []),
        ],
    };
}

function decodeSweep(p, chainSuffix) {
    const dest = str(p.DESTINATION);
    const memo = str(p.MEMO);
    // SWEEP v0 selective flags: BALANCES/OWNERSHIPS default on, the
    // escrow-closing flags (ORDERS/SWAPS/DISPENSERS) default off.
    const flagOn = (v, dflt) => (v === undefined || v === null || str(v) === '' ? dflt : str(v) === '1');
    const swept = [];
    if (flagOn(p.BALANCES, true)) swept.push('balances');
    if (flagOn(p.OWNERSHIPS, true)) swept.push('ownerships');
    if (flagOn(p.ORDERS, false)) swept.push('open orders');
    if (flagOn(p.SWAPS, false)) swept.push('open swaps');
    if (flagOn(p.DISPENSERS, false)) swept.push('open dispensers');
    const sweptLabel = swept.length ? swept.join(', ') : 'nothing';
    return {
        summary: `Sweep ${sweptLabel}${chainSuffix} to ${dest || '?'}`,
        details: [
            { label: 'Destination', value: dest },
            { label: 'Sweeps', value: sweptLabel },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'Sweep moves the selected balances and ownerships from the source address. Double-check the destination.',
            ...(!dest ? ['Destination is empty.'] : []),
        ],
    };
}

function decodeMint(p, chainSuffix) {
    const tick = str(p.TICK);
    const amount = str(p.AMOUNT);
    const dest = str(p.DESTINATION);
    const memo = str(p.MEMO);
    return {
        summary: `Mint ${amount || '?'} ${tick || '?'}${chainSuffix}${dest ? ` to ${dest}` : ''}`,
        details: [
            { label: 'Token', value: tick },
            { label: 'Amount', value: amount },
            ...(dest ? [{ label: 'Destination', value: dest }] : [{ label: 'Destination', value: 'broadcasting address' }]),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!tick ? ['Token ticker is empty.'] : []),
            ...(!amount || Number(amount) <= 0
                ? ['Amount is not positive.']
                : []),
            ...(memo && /[|;]/.test(memo)
                ? ['Memo contains | or ;: the protocol will reject this transaction.']
                : []),
        ],
    };
}

function decodeDestroy(p, chainSuffix) {
    // Protocol §DESTROY v0 (single) is VERSION|TICK|AMOUNT|MEMO.
    // v1/v2 support multi-destroy (repeating TICK/AMOUNT pairs); those
    // fall through to the generic describer and still get the
    // irreversibility warning because the action kind is DESTROY.
    const version = str(p.VERSION);
    const tick = str(p.TICK);
    const amount = str(p.AMOUNT);
    const memo = str(p.MEMO);
    const isSingle = (version === '' || version === '0') && !Array.isArray(p.TICK);
    if (isSingle) {
        return {
            summary: `Destroy ${amount || '?'} ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                { label: 'Amount', value: amount },
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                'Destroying is irreversible. The tokens cannot be recovered.',
                ...(!tick ? ['Token ticker is empty.'] : []),
                ...(!amount || Number(amount) <= 0
                    ? ['Amount is not positive.']
                    : []),
                ...(memo && /[|;]/.test(memo)
                    ? ['Memo contains | or ;: the protocol will reject this transaction.']
                    : []),
            ],
        };
    }
    const generic = genericFallback('DESTROY', p, chainSuffix);
    generic.warnings.unshift(
        'Destroying is irreversible. The tokens cannot be recovered.',
    );
    return generic;
}

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

/*
 * BROADCAST describer. v0 plain message, v1 oracle value, v2 feed
 * announcement, v3 feed-results resolve.
 */
function decodeBroadcast(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const message = str(p.MESSAGE);
    const value = str(p.VALUE);
    const fee = str(p.FEE);
    const memo = str(p.MEMO);
    const actionIndex = str(p.BROADCAST_ACTION_INDEX);

    const baseWarnings = [
        ...(memo && /[|;]/.test(memo)
            ? ['Memo contains | or ;: the protocol will reject this transaction.']
            : []),
        ...(message && /[|;]/.test(message)
            ? ['Message contains | or ;: the protocol will reject this transaction.']
            : []),
    ];

    if (version === '3') {
        return {
            summary: `Publish feed result${chainSuffix}${actionIndex ? ` (feed #${actionIndex})` : ''}`,
            details: [
                ...(actionIndex ? [{ label: 'Feed action index', value: actionIndex }] : []),
                ...(value ? [{ label: 'Value', value }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!actionIndex ? ['Feed action index is empty.'] : []),
                ...baseWarnings,
            ],
        };
    }

    if (version === '1') {
        return {
            summary: `Publish oracle value ${value || '?'} for ${message || '?'}${chainSuffix}`,
            details: [
                { label: 'Feed', value: message },
                { label: 'Value', value },
                ...(fee ? [{ label: 'Feed fee', value: `${fee}%` }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!message ? ['Feed name is empty.'] : []),
                ...(!value ? ['Oracle value is empty.'] : []),
                ...baseWarnings,
            ],
        };
    }

    if (version === '2') {
        return {
            summary: `Publish feed ${message || '?'}${chainSuffix}`,
            details: [
                { label: 'Feed', value: message },
                ...(fee ? [{ label: 'Feed fee', value: `${fee}%` }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!message ? ['Feed identifier is empty.'] : []),
                ...baseWarnings,
            ],
        };
    }

    return {
        summary: `Broadcast "${message || ''}"${chainSuffix}`,
        details: [
            { label: 'Message', value: message },
            ...(value ? [{ label: 'Value', value }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!message ? ['Message is empty.'] : []),
            ...baseWarnings,
        ],
    };
}

/*
 * ISSUE describer. Seven format versions: v0 create-or-configure,
 * v1 description edit, v2 mint params, v3 locks, v4 callback,
 * v5 allow/block lists, v6 controller bind/unbind.
 */
function decodeIssue(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const tick = str(p.TICK);
    const memo = str(p.MEMO);

    const baseWarnings = [
        ...(!tick ? ['Token ticker is empty.'] : []),
        ...(memo && /[|;]/.test(memo)
            ? ['Memo contains | or ;: the protocol will reject this transaction.']
            : []),
    ];

    if (version === '1') {
        const description = str(p.DESCRIPTION);
        return {
            summary: `Update description of ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                { label: 'New description', value: description },
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: baseWarnings,
        };
    }

    if (version === '2') {
        const maxMint = str(p.MAX_MINT);
        const mintSupply = str(p.MINT_SUPPLY);
        const transferSupply = str(p.TRANSFER_SUPPLY);
        const mintAddressMax = str(p.MINT_ADDRESS_MAX);
        const mintStart = str(p.MINT_START_BLOCK);
        const mintStop = str(p.MINT_STOP_BLOCK);
        return {
            summary: `Update mint parameters of ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(maxMint ? [{ label: 'Max mint per tx', value: maxMint }] : []),
                ...(mintSupply ? [{ label: 'Mint now', value: mintSupply }] : []),
                ...(transferSupply ? [{ label: 'Transfer minted supply to', value: transferSupply }] : []),
                ...(mintAddressMax ? [{ label: 'Max mint per address', value: mintAddressMax }] : []),
                ...(mintStart ? [{ label: 'Mint start block', value: mintStart }] : []),
                ...(mintStop ? [{ label: 'Mint stop block', value: mintStop }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: baseWarnings,
        };
    }

    if (version === '3') {
        const lockFlags = collectLockFlags(p);
        return {
            summary: lockFlags.length > 0
                ? `Lock ${tick || '?'} (${lockFlags.join(', ')})${chainSuffix}`
                : `Update lock parameters of ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(lockFlags.length > 0
                    ? [{ label: 'Locking', value: lockFlags.join(', ') }]
                    : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(lockFlags.length > 0
                    ? ['Locking is permanent. These properties cannot be changed after this transaction confirms.']
                    : []),
                ...baseWarnings,
            ],
        };
    }

    if (version === '4') {
        const callbackBlock = str(p.CALLBACK_BLOCK);
        const callbackTick = str(p.CALLBACK_TICK);
        const callbackAmount = str(p.CALLBACK_AMOUNT);
        return {
            summary: `Update callback parameters of ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(callbackBlock ? [{ label: 'Callback at block', value: callbackBlock }] : []),
                ...(callbackTick ? [{ label: 'Callback token', value: callbackTick }] : []),
                ...(callbackAmount ? [{ label: 'Callback amount', value: callbackAmount }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: baseWarnings,
        };
    }

    if (version === '5') {
        const allowList = str(p.ALLOW_LIST);
        const blockList = str(p.BLOCK_LIST);
        return {
            summary: `Update allow/block list for ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(allowList ? [{ label: 'Allow list', value: allowList }] : []),
                ...(blockList ? [{ label: 'Block list', value: blockList }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: baseWarnings,
        };
    }

    if (version === '6') {
        // Controller bind/unbind (programmable policy layer).
        const controller = str(p.CONTROLLER);
        const actionClass = str(p.ACTION_CLASS);
        const cooldown = str(p.COOLDOWN_BLOCKS);
        const unbind = str(p.UNBIND) === '1';
        return {
            summary: unbind
                ? `Unbind controller from ${tick || '?'}${actionClass ? ` (${actionClass})` : ''}${chainSuffix}`
                : `Bind ${tick || '?'} to controller${controller ? ` #${controller}` : ''}${actionClass ? ` (${actionClass})` : ''}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(controller ? [{ label: 'Controller contract', value: controller }] : []),
                ...(actionClass ? [{ label: 'Action class', value: actionClass }] : []),
                ...(cooldown ? [{ label: 'Cooldown blocks', value: cooldown }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                unbind
                    ? 'Unbinding removes the controller policy after the cooldown elapses.'
                    : 'A controller contract will be able to veto or gate this token\'s actions for the bound class.',
                ...baseWarnings,
            ],
        };
    }

    // Version 0: full create-or-update.
    const maxSupply = str(p.MAX_SUPPLY);
    const maxMint = str(p.MAX_MINT);
    const decimals = str(p.DECIMALS);
    const description = str(p.DESCRIPTION);
    const mintSupply = str(p.MINT_SUPPLY);
    const transfer = str(p.TRANSFER);
    const transferSupply = str(p.TRANSFER_SUPPLY);
    const mintAddressMax = str(p.MINT_ADDRESS_MAX);
    const mintStart = str(p.MINT_START_BLOCK);
    const mintStop = str(p.MINT_STOP_BLOCK);
    const lockFlags = collectLockFlags(p);

    const isCreate = maxSupply !== '' || mintSupply !== '';
    const isTransferOnly = !isCreate && transfer !== '' && maxMint === '' && description === '';

    let summary;
    if (isCreate) {
        summary = maxSupply
            ? `Create token ${tick || '?'} with max supply ${maxSupply}${chainSuffix}`
            : `Create token ${tick || '?'}${chainSuffix}`;
    } else if (isTransferOnly) {
        summary = `Transfer ownership of ${tick || '?'} to ${transfer}${chainSuffix}`;
    } else {
        summary = `Configure token ${tick || '?'}${chainSuffix}`;
    }

    const details = [
        { label: 'Token', value: tick },
        ...(maxSupply ? [{ label: 'Max supply', value: maxSupply }] : []),
        ...(maxMint ? [{ label: 'Max mint per tx', value: maxMint }] : []),
        ...(mintAddressMax ? [{ label: 'Max mint per address', value: mintAddressMax }] : []),
        ...(mintStart ? [{ label: 'Mint start block', value: mintStart }] : []),
        ...(mintStop ? [{ label: 'Mint stop block', value: mintStop }] : []),
        ...(decimals ? [{ label: 'Decimals', value: decimals }] : []),
        ...(description ? [{ label: 'Description', value: description }] : []),
        ...(mintSupply ? [{ label: 'Initial mint', value: mintSupply }] : []),
        ...(transfer ? [{ label: 'Transfer ownership to', value: transfer }] : []),
        ...(transferSupply ? [{ label: 'Transfer initial supply to', value: transferSupply }] : []),
        ...(lockFlags.length > 0
            ? [{ label: 'Locking', value: lockFlags.join(', ') }]
            : []),
        ...(memo ? [{ label: 'Memo', value: memo }] : []),
    ];

    const warnings = [
        ...(lockFlags.length > 0
            ? ['Locking is permanent. These properties cannot be changed after this transaction confirms.']
            : []),
        ...baseWarnings,
    ];

    return { summary, details, warnings };
}

/*
 * BATCH describer. Prefers ParsedAction.commands (decoder.parse output:
 * each entry a ParsedAction or {ok:false, code}); falls back to the
 * wallet's legacy `{ COMMANDS: [{action, params}] }` shape. A failed
 * sub-parse renders as an explicit per-command line ("Command 3: ...")
 * without hiding the rest.
 */
function decodeBatch(parsed, p, ctx, chainSuffix) {
    let children = null;

    if (parsed && Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        children = parsed.commands.map((cmd, i) => {
            if (!cmd || cmd.ok === false) {
                const code = cmd && cmd.code ? cmd.code : 'MALFORMED';
                return {
                    summary: `Command ${i + 1} could not be decoded (${code})`,
                    details: [],
                    warnings: [`Batch command ${i + 1} could not be decoded (${code}). Review the raw transaction carefully before signing.`],
                };
            }
            return describe(cmd, ctx);
        });
    } else if (Array.isArray(p.COMMANDS) && p.COMMANDS.length > 0) {
        children = p.COMMANDS.map((cmd) => {
            if (!cmd || typeof cmd !== 'object') {
                return {
                    summary: 'Unknown command',
                    details: [],
                    warnings: ['A batch command is malformed.'],
                };
            }
            return describe({ action: cmd.action, params: cmd.params }, ctx);
        });
    }

    if (!children || children.length === 0) {
        return {
            summary: `Batch of actions${chainSuffix}`,
            details: [],
            warnings: [
                'Batch has no decoded commands. Review the raw transaction carefully before signing.',
            ],
        };
    }

    const summaryLines = children.map((c, i) => `${i + 1}. ${c.summary}`);
    const summary = `Batch of ${children.length} action${children.length === 1 ? '' : 's'}${chainSuffix}:\n${summaryLines.join('\n')}`;

    const details = children.flatMap((child, i) => [
        { label: `Step ${i + 1}`, value: child.summary },
        ...child.details.map((d) => ({ label: `  ${d.label}`, value: d.value })),
    ]);

    const warnings = children.flatMap((child) => child.warnings);
    // BATCH is sequential and stateful, not atomic: a mid-batch reject
    // does not roll back earlier commands.
    warnings.push('Batch commands execute in order and are NOT atomic: if one fails, the earlier commands still apply.');

    return { summary, details, warnings };
}

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

    if (version === '1') {
        return {
            summary: `Cancel ${noun}${chainSuffix}${idx ? ` (#${idx})` : ''}`,
            details: [
                ...(idx ? [{ label: `${action === 'SWAP' ? 'Swap' : 'Order'} action index`, value: idx }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [...(!idx ? [`${action === 'SWAP' ? 'Swap' : 'Order'} action index is empty.`] : []), ...memoWarnings],
        };
    }

    if (version === '2') {
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

function getCoinLabel(coin) {
    return coin ? `${coin} (native coin)` : '';
}

/*
 * STAKE describer. v1 new capability stake, v2 top-up, v3
 * contract-targeted. The version IS the semantics (v1/v2 share a wire
 * shape), so it is always shown.
 */
function decodeStake(p, chainSuffix) {
    const version = str(p.VERSION) || '1';
    const amount = str(p.AMOUNT);
    const pubkey = str(p.SIGNING_PUBKEY);
    const target = str(p.TARGET_CONTRACT_INDEX);
    const tick = str(p.TICK);
    const kind = version === '3'
        ? `to contract${target ? ` #${target}` : ''}`
        : version === '2' ? '(top-up)' : '(new validator stake)';
    return {
        summary: `Stake ${amount || '?'}${version === '3' && tick ? ` ${tick}` : ''}${chainSuffix} ${kind}`,
        details: [
            { label: 'Amount', value: amount },
            ...(version === '3' && tick ? [{ label: 'Token', value: tick }] : []),
            ...(target ? [{ label: 'Target contract', value: `#${target}` }] : []),
            { label: 'Signing public key', value: pubkey },
        ],
        warnings: [
            ...(!amount || Number(amount) <= 0 ? ['Stake amount is not positive.'] : []),
            ...(!pubkey ? ['Signing public key is empty.'] : []),
            'Staked funds are locked until unstake plus the cooldown period.',
        ],
    };
}

/* UNSTAKE describer. v0 capability, v1 contract-targeted. */
function decodeUnstake(p, chainSuffix) {
    const target = str(p.TARGET_CONTRACT_INDEX);
    const tick = str(p.TICK);
    const pubkey = str(p.SIGNING_PUBKEY);
    return {
        summary: `Unstake${tick ? ` ${tick}` : ''}${target ? ` from contract #${target}` : ''}${chainSuffix}`,
        details: [
            ...(tick ? [{ label: 'Token', value: tick }] : []),
            ...(target ? [{ label: 'Target contract', value: `#${target}` }] : []),
            { label: 'Signing public key', value: pubkey },
        ],
        warnings: [
            ...(!pubkey ? ['Signing public key is empty.'] : []),
            'Unstaked funds enter a cooldown before they are spendable.',
        ],
    };
}

/*
 * DELEGATE describer: validator signing-key rotation (v0/v1 rotate,
 * v2/v3 revoke), NOT poll vote delegation (that is VOTE v3).
 */
function decodeDelegate(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const isRevoke = version === '2' || version === '3';
    const newKey = str(p.NEW_SIGNING_PUBKEY);
    const key = str(p.SIGNING_PUBKEY);
    const target = str(p.TARGET_CONTRACT_INDEX);
    const tick = str(p.TICK);
    return {
        summary: isRevoke
            ? `Revoke validator signing key${target ? ` for contract #${target}` : ''}${chainSuffix}`
            : `Rotate validator signing key${target ? ` for contract #${target}` : ''}${chainSuffix}`,
        details: [
            ...(isRevoke
                ? [{ label: 'Signing public key', value: key }]
                : [{ label: 'New signing public key', value: newKey }]),
            ...(target ? [{ label: 'Target contract', value: `#${target}` }] : []),
            ...(tick ? [{ label: 'Token', value: tick }] : []),
        ],
        warnings: [
            ...((isRevoke ? !key : !newKey) ? ['Signing public key is empty.'] : []),
            'This changes which key signs for your stake. Verify the key belongs to you.',
        ],
    };
}

/*
 * VOTE describer: token-weighted governance. v0 create poll, v1 cast
 * ballot, v3 delegate standing vote (v2 finalize is system-only).
 */
function decodeVote(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const memo = str(p.MEMO);
    if (version === '1') {
        const pollRef = str(p.POLL_REF);
        const ballot = str(p.BALLOT);
        return {
            summary: `Cast ballot "${ballot || '?'}" on poll${pollRef ? ` #${pollRef}` : ''}${chainSuffix}`,
            details: [
                { label: 'Poll', value: pollRef ? `#${pollRef}` : '' },
                { label: 'Ballot', value: ballot },
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(!pollRef ? ['Poll reference is empty.'] : []),
                ...(!ballot ? ['Ballot is empty.'] : []),
                'A later ballot on the same poll overwrites this one.',
            ],
        };
    }
    if (version === '3') {
        const tick = str(p.TICK);
        const delegateTo = str(p.DELEGATE_TO);
        return {
            summary: delegateTo
                ? `Delegate ${tick || '?'} voting power to ${delegateTo}${chainSuffix}`
                : `Clear ${tick || '?'} vote delegation${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(delegateTo ? [{ label: 'Delegate to', value: delegateTo }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: delegateTo
                ? ['The delegate votes with your token weight until you clear the delegation.']
                : [],
        };
    }
    // v0 create poll.
    const tick = str(p.TICK);
    const endBlock = str(p.END_BLOCK);
    const question = str(p.QUESTION);
    const options = str(p.OPTIONS);
    return {
        summary: `Create poll for ${tick || '?'} holders${chainSuffix}${question ? `: ${question}` : ''}`,
        details: [
            { label: 'Token', value: tick },
            ...(question ? [{ label: 'Question', value: question }] : []),
            ...(options ? [{ label: 'Options', value: options }] : []),
            ...(endBlock ? [{ label: 'End block', value: endBlock }] : []),
        ],
        warnings: [
            ...(!tick ? ['Token ticker is empty.'] : []),
            ...(!endBlock ? ['End block is empty.'] : []),
        ],
    };
}

/*
 * DEPLOY describer. v0/v1 inline source (CODE_ENCODING = base64),
 * v2/v3 chunked assembly by CODE_HASH, v4 chunk carrier.
 */
function decodeDeploy(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const gasLimit = str(p.GAS_LIMIT);
    if (version === '4') {
        const idx = str(p.CHUNK_INDEX);
        const total = str(p.TOTAL_CHUNKS);
        return {
            summary: `Upload contract code chunk ${idx || '?'} of ${total || '?'}${chainSuffix}`,
            details: [
                { label: 'Chunk', value: `${idx || '?'} / ${total || '?'}` },
                { label: 'Code hash', value: str(p.CODE_HASH) },
            ],
            warnings: [],
        };
    }
    const chunked = version === '2' || version === '3';
    const stakeable = version === '1' || version === '3';
    const codeLen = str(p.CODE_ENCODING).length;
    return {
        summary: `Deploy ${stakeable ? 'stakeable ' : ''}smart contract${chainSuffix}${chunked ? ' (from uploaded chunks)' : ''}`,
        details: [
            ...(chunked
                ? [{ label: 'Code hash', value: str(p.CODE_HASH) }]
                : [{ label: 'Code size (base64)', value: String(codeLen) }]),
            ...(gasLimit ? [{ label: 'Gas limit', value: gasLimit }] : []),
            ...(stakeable && str(p.COOLDOWN_BLOCKS) ? [{ label: 'Cooldown blocks', value: str(p.COOLDOWN_BLOCKS) }] : []),
            ...(stakeable && str(p.SLASH_DESTINATION) ? [{ label: 'Slash destination', value: str(p.SLASH_DESTINATION) }] : []),
        ],
        warnings: [
            'Deployed contract code is immutable and its constructor runs once at deploy.',
            ...(!gasLimit ? ['Gas limit is empty.'] : []),
        ],
    };
}

/* EXECUTE describer: call a deployed contract method (gas is the fee). */
function decodeExecute(p, chainSuffix) {
    const idx = str(p.CONTRACT_ACTION_INDEX);
    const method = str(p.METHOD);
    const params = toArray(p.PARAMS);
    return {
        summary: `Call ${method || '?'}() on contract${idx ? ` #${idx}` : ''}${chainSuffix}`,
        details: [
            { label: 'Contract', value: idx ? `#${idx}` : '' },
            { label: 'Method', value: method },
            ...(params.length ? [{ label: 'Arguments', value: params.join(', ') }] : []),
        ],
        warnings: [
            ...(!idx ? ['Contract action index is empty.'] : []),
            ...(!method ? ['Method name is empty.'] : []),
            'Gas is charged even if the contract call fails at runtime.',
        ],
    };
}

/* DEPOSIT / WITHDRAW describer: move tokens into/out of a contract. */
function decodeContractFunds(action, p, chainSuffix) {
    const idx = str(p.CONTRACT_ACTION_INDEX);
    const tick = str(p.TICK);
    const qty = str(p.QUANTITY);
    const verb = action === 'DEPOSIT' ? 'Deposit' : 'Withdraw';
    const prep = action === 'DEPOSIT' ? 'into' : 'from';
    return {
        summary: `${verb} ${qty || '?'} ${tick || '?'} ${prep} contract${idx ? ` #${idx}` : ''}${chainSuffix}`,
        details: [
            { label: 'Contract', value: idx ? `#${idx}` : '' },
            { label: 'Token', value: tick },
            { label: 'Amount', value: qty },
        ],
        warnings: [
            ...(!idx ? ['Contract action index is empty.'] : []),
            ...(!qty || Number(qty) <= 0 ? ['Amount is not positive.'] : []),
            ...(action === 'WITHDRAW' ? ['Only the contract deployer can withdraw contract credit.'] : []),
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

/* COLLECT describer: claim accrued validator rewards. */
function decodeCollect(p, chainSuffix) {
    return {
        summary: `Collect validator rewards${chainSuffix}`,
        details: [],
        warnings: [],
    };
}

/*
 * MESSAGE describer. v0/v1 key exchange, v2 encrypted payload, v3
 * plaintext. Encrypted bodies are unreadable by design; say so rather
 * than render ciphertext.
 */
function decodeMessage(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const dest = str(p.DESTINATION);
    const coin = str(p.COIN);
    if (version === '3') {
        const text = str(p.PLAINTEXT_MESSAGE);
        return {
            summary: `Send public message to ${dest || '?'}${chainSuffix}`,
            details: [
                { label: 'To', value: dest },
                ...(coin ? [{ label: 'Chain', value: coin }] : []),
                { label: 'Message', value: text },
            ],
            warnings: ['This message is PUBLIC and permanent on the blockchain.'],
        };
    }
    if (version === '2') {
        return {
            summary: `Send encrypted message to ${dest || '?'}${chainSuffix}`,
            details: [
                { label: 'To', value: dest },
                ...(coin ? [{ label: 'Chain', value: coin }] : []),
                { label: 'Body', value: '(encrypted)' },
            ],
            warnings: [...(!dest ? ['Destination is empty.'] : [])],
        };
    }
    return {
        summary: `Publish messaging key for ${dest || '?'}${chainSuffix}`,
        details: [
            { label: 'Address', value: dest },
            ...(str(p.ENCRYPTION_METHOD) ? [{ label: 'Encryption method', value: str(p.ENCRYPTION_METHOD) }] : []),
        ],
        warnings: [],
    };
}

/* FILE describer: publish a (possibly gated) file record. */
function decodeFile(p, chainSuffix) {
    const name = str(p.NAME);
    const type = str(p.TYPE);
    const title = str(p.TITLE);
    const gate = str(p.GATE_TICKER);
    return {
        summary: `Publish file ${name || '?'}${chainSuffix}${gate ? ` (gated by ${gate})` : ''}`,
        details: [
            { label: 'Name', value: name },
            { label: 'Type', value: type },
            ...(title ? [{ label: 'Title', value: title }] : []),
            ...(gate ? [{ label: 'Gate token', value: gate }] : []),
            ...(str(p.ENCRYPTION_METHOD) ? [{ label: 'Encryption', value: str(p.ENCRYPTION_METHOD) }] : []),
        ],
        warnings: [
            ...(!name ? ['File name is empty.'] : []),
            'File contents are permanent and public on the blockchain (encrypted if gated).',
        ],
    };
}

/* LINK describer: bind two actions across chains. */
function decodeLink(p, chainSuffix) {
    const coin1 = str(p.COIN1);
    const idx1 = str(p.COIN1_ACTION_INDEX);
    const coin2 = str(p.COIN2);
    const idx2 = str(p.COIN2_ACTION_INDEX);
    return {
        summary: `Link ${coin1 || '?'} action #${idx1 || '?'} to ${coin2 || '?'} action #${idx2 || '?'}${chainSuffix}`,
        details: [
            { label: 'Chain 1', value: coin1 },
            { label: 'Action 1', value: idx1 ? `#${idx1}` : '' },
            { label: 'Chain 2', value: coin2 },
            { label: 'Action 2', value: idx2 ? `#${idx2}` : '' },
        ],
        warnings: [
            ...(!coin1 || !coin2 ? ['Both chains must be specified.'] : []),
        ],
    };
}

/* SLEEP describer: pause a token until a resume block. */
function decodeSleep(p, chainSuffix) {
    const resumeBlock = str(p.RESUME_BLOCK);
    const tick = str(p.TICK);
    return {
        summary: `Pause ${tick || 'token activity'}${chainSuffix} until block ${resumeBlock || '?'}`,
        details: [
            ...(tick ? [{ label: 'Token', value: tick }] : []),
            { label: 'Resume block', value: resumeBlock },
        ],
        warnings: [
            'While asleep, transfers of the affected token are rejected.',
            ...(!resumeBlock ? ['Resume block is empty.'] : []),
        ],
    };
}

/* CALLBACK describer: force-redeem a token per its callback terms. */
function decodeCallback(p, chainSuffix) {
    const tick = str(p.TICK);
    return {
        summary: `Trigger callback redemption of ${tick || '?'}${chainSuffix}`,
        details: [{ label: 'Token', value: tick }],
        warnings: [
            'Callback redeems ALL holders\' tokens at the configured callback terms. This cannot be undone.',
            ...(!tick ? ['Token ticker is empty.'] : []),
        ],
    };
}

/*
 * PRICE describer (wallet PC-30 version, promoted here by ).
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
 * BET describer ( §11.3 signing, promoted from the wallet by
 * ). One action name over four formats, so the summary must name
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

    // v2 place a bet
    if (version === '2') {
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

    // v3 resolve a market
    if (version === '3') {
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

    // v1 cancel a market
    if (version === '1') {
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

/*
 * Collect human-readable names of every lock flag the ISSUE params
 * turn on. Any truthy value (including the serialized "1") counts.
 */
function collectLockFlags(p) {
    const flags = [
        ['LOCK_MAX_SUPPLY', 'max supply'],
        ['LOCK_MAX_MINT', 'max mint'],
        ['LOCK_MINT', 'minting'],
        ['LOCK_MINT_SUPPLY', 'mint-supply'],
        ['LOCK_DESCRIPTION', 'description'],
        ['LOCK_SLEEP', 'sleep'],
        ['LOCK_CALLBACK', 'callback'],
    ];
    const active = [];
    for (const [field, label] of flags) {
        const v = p[field];
        if (v === undefined || v === null || v === '' || v === '0' || v === 0 || v === false) continue;
        active.push(label);
    }
    return active;
}

function genericFallback(action, p, chainSuffix) {
    // Param keys are raw wire fields (TICK, GAS_LIMIT); title-case them
    // directly rather than via actionDisplayLabel, whose action-name map
    // would mistranslate keys that collide with action verbs (e.g. LIST).
    const humanizeKey = (k) => {
        const words = String(k).trim().toLowerCase().replace(/[_-]+/g, ' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    };
    const paramEntries = Object.entries(p)
        .filter(([k]) => k !== 'VERSION')
        .map(([k, v]) => ({
            label: humanizeKey(k),
            value: typeof v === 'string' ? v : safeJson(v),
        }));
    const verb = action ? actionDisplayLabel(action) : 'unknown action';
    return {
        summary: `Sign ${verb}${chainSuffix}`,
        details: paramEntries,
        warnings: [
            `No plain-English summary is available for "${verb}" yet. Review the parameters carefully before approving.`,
        ],
    };
}

function str(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.map((x) => str(x)).join(', ');
    return String(v);
}

// First slot of a multi-leg array field, else the value itself.
function firstStr(v) {
    return String(v).split(', ')[0];
}

function toArray(v) {
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && x !== '');
    return [v];
}

function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch (_err) {
        return String(v);
    }
}

module.exports = { describe };
