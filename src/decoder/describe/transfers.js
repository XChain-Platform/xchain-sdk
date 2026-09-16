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

const { str, firstStr, toScaledUnits, fromScaledUnits, toArray } = require('./value_format.js');

/* ------------------------------------------------------------------ *
 *  Per-action describers (ported verbatim from the wallet decoder,
 *  CommonJS-ified; behavior changes are limited to BATCH consuming
 *  ParsedAction.commands and the hardening pass above).
 * ------------------------------------------------------------------ */

/*
 * ADDRESS describer. v0 sets per-address options (fee disposition,
 * received-SEND memo requirement, who may open a dispenser on this
 * address); v1 binds or unbinds a controller contract for one action
 * class, the account-level twin of ISSUE v6.
 *
 * v0 fields are independently optional and a blank one is not "off": a
 * blank DISPENSER_PREFERENCE preserves the previous value while a blank
 * FEE_PREFERENCE resets to the default (ADDRESS.md Notes). The summary
 * therefore lists only the settings this action actually changes, and an
 * ADDRESS that changes nothing says so rather than implying it did.
 */
function decodeAddress(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const memo = str(p.MEMO);
    const memoWarnings = memo && /[|;]/.test(memo)
        ? ['Memo contains | or ;: the protocol will reject this transaction.']
        : [];

    if (version === '1') return decodeAddressController(p, chainSuffix, memo, memoWarnings);
    return decodeAddressOptions(p, chainSuffix, memo, memoWarnings);
}

function decodeAddressController(p, chainSuffix, memo, memoWarnings) {
    const controller = str(p.CONTROLLER);
    const actionClass = str(p.ACTION_CLASS);
    const cooldown = str(p.COOLDOWN_BLOCKS);
    const unbind = str(p.UNBIND) === '1';
    return {
        summary: unbind
            ? `Unbind controller from this address${actionClass ? ` (${actionClass})` : ''}${chainSuffix}`
            : `Bind this address to controller${controller ? ` #${controller}` : ''}${actionClass ? ` (${actionClass})` : ''}${chainSuffix}`,
        details: [
            ...(controller ? [{ label: 'Controller contract', value: `#${controller}` }] : []),
            ...(actionClass ? [{ label: 'Action class', value: actionClass }] : []),
            ...(cooldown ? [{ label: 'Cooldown blocks', value: cooldown }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            unbind
                ? 'Unbinding removes the controller policy after the cooldown elapses.'
                : 'A controller contract will be able to veto or gate this address\'s actions for the bound class. A transfer binding gates BOTH sends from and sends to this address.',
            ...(!unbind && !controller ? ['Controller contract index is empty.'] : []),
            ...(!actionClass ? ['Action class is empty.'] : []),
            ...memoWarnings,
        ],
    };
}

function decodeAddressOptions(p, chainSuffix, memo, memoWarnings) {
    const feePref = str(p.FEE_PREFERENCE);
    const requireMemo = str(p.REQUIRE_MEMO);
    const dispenserPref = str(p.DISPENSER_PREFERENCE);

    const feeLabel = feePref === '1' ? 'fees destroyed (lowers supply)'
        : feePref === '2' ? 'fees donated to protocol development'
            : feePref === '0' ? 'fees at the default disposition'
                : '';
    const memoLabel = requireMemo === '1' ? 'a memo required on every incoming send'
        : requireMemo === '0' ? 'no memo required on incoming sends'
            : '';
    const dispenserLabel = dispenserPref === '2' ? 'anyone may open a dispenser on this address'
        : dispenserPref === '1' ? 'only the owner may open a dispenser on this address'
            : '';

    const changes = [feeLabel, memoLabel, dispenserLabel].filter(Boolean);

    return {
        summary: changes.length
            ? `Set address options${chainSuffix}: ${changes.join(', ')}`
            : `Set address options${chainSuffix} (no options changed)`,
        details: [
            ...(feeLabel ? [{ label: 'Fee preference', value: feeLabel }] : []),
            ...(memoLabel ? [{ label: 'Memo requirement', value: memoLabel }] : []),
            ...(dispenserLabel ? [{ label: 'Dispenser preference', value: dispenserLabel }] : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(changes.length === 0
                ? ['This action sets no address options. Every option field is blank.']
                : []),
            ...(feePref !== '' && !['0', '1', '2'].includes(feePref)
                ? ['Fee preference must be 0, 1 or 2: the protocol will reject this transaction.']
                : []),
            ...(feePref === '1'
                ? ['Destroyed fees are burned permanently and cannot be recovered.']
                : []),
            ...(dispenserPref === '2'
                ? ['Anyone will be able to open a dispenser on this address.']
                : []),
            ...memoWarnings,
        ],
    };
}

function decodeSend(p, chainSuffix) {
    const tick = str(p.TICK);
    const amount = str(p.AMOUNT);
    const dest = str(p.DESTINATION);
    const memo = str(p.MEMO);
    // SEND v1/v2/v3 pay SEVERAL recipients from one action, so AMOUNT and
    // DESTINATION arrive as arrays. Described leg by leg: the single-send
    // wording below reads `firstStr` of each, which on a three-recipient send
    // produced "Send 7 XCHAIN to <recipient 1>" - a headline naming ONE
    // recipient and ONE amount for a transaction that pays three, on the
    // screen whose job is to state what is being authorized. Found by driving
    // a real multi-recipient send through the wallet on regtest.
    const multi = decodeMultiSend(p, chainSuffix);
    if (multi) return multi;
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

/**
 * The multi-recipient half of decodeSend: null when this is an ordinary
 * single-leg send, so the caller keeps its existing wording untouched.
 *
 * Totals are per TOKEN, because SEND v2 lets each leg carry its own tick, and
 * a summary that added 7 XCHAIN to 3 PEPECREATURE would be worse than one that
 * named a single leg. Amounts are summed EXACTLY, as scaled BigInt units, only
 * when every leg parses; otherwise the total is omitted rather than guessed,
 * since a wrong total on a signing screen is the failure mode this whole path
 * exists to prevent.
 */
function decodeMultiSend(p, chainSuffix) {
    const dests = toArray(p.DESTINATION);
    if (dests.length < 2) return null;
    const amounts = toArray(p.AMOUNT);
    const ticks = toArray(p.TICK);
    const memos = toArray(p.MEMO);
    // One TICK/MEMO covers every leg on v1/v3; v2 carries one per leg.
    const tickAt = (i) => String(ticks.length > 1 ? (ticks[i] ?? '') : (ticks[0] ?? ''));
    const memoAt = (i) => String(memos.length > 1 ? (memos[i] ?? '') : (memos[0] ?? ''));

    /** @type {Map<string, bigint|null>} */
    const totals = new Map();
    for (let i = 0; i < dests.length; i++) {
        const tick = tickAt(i) || '?';
        const units = toScaledUnits(amounts[i]);
        const running = totals.has(tick) ? totals.get(tick) : 0n;
        totals.set(tick, running === null || units === null ? null : running + units);
    }
    const totalsText = [...totals.entries()]
        .map(([tick, sum]) => (sum === null ? tick : `${fromScaledUnits(sum)} ${tick}`))
        .join(', ');

    return {
        summary: `Send ${totalsText}${chainSuffix} to ${dests.length} recipients`,
        details: dests.map((dest, i) => ({
            label: `Recipient ${i + 1}`,
            value: `${String(amounts[i] ?? '?')} ${tickAt(i) || '?'} to ${String(dest)}`
                + (memoAt(i) ? ` (memo: "${memoAt(i)}")` : ''),
        })),
        warnings: [
            ...(amounts.length !== dests.length
                ? ['This send has a different number of amounts and recipients.']
                : []),
            ...(dests.some((d) => !String(d).trim()) ? ['A destination is empty.'] : []),
            ...(amounts.some((a) => !(Number(a) > 0)) ? ['An amount is not positive.'] : []),
            ...(memos.some((m) => /[|;]/.test(String(m)))
                ? ['Memo contains | or ;: the protocol will reject this transaction.']
                : []),
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

module.exports = { decodeAddress, decodeSend, decodeMultiSend, decodeSweep };
