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

const { str, toArray, collectLockFlags } = require('./value_format.js');

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

/*
 * DESTROY describer. v0 single is VERSION|TICK|AMOUNT|MEMO; v1/v2 are
 * multi-destroy (repeating TICK/AMOUNT, v2 adding a per-leg MEMO), which
 * arrive from parse() as parallel arrays.
 *
 * Each multi-destroy leg is described individually: DESTROY is the single
 * most irreversible action in the protocol, so a signing screen must never
 * fall back to "No plain-English summary is available" just because more
 * than one token burned.
 */
function decodeDestroy(p, chainSuffix) {
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
    // Multi-destroy. v2 carries one MEMO per leg; v1 carries a single
    // trailing MEMO for the whole action.
    const ticks = toArray(p.TICK);
    const amounts = toArray(p.AMOUNT);
    const memos = toArray(p.MEMO);
    const perLegMemo = version === '2';
    const n = Math.max(ticks.length, amounts.length, 1);

    const legs = [];
    for (let i = 0; i < n; i += 1) {
        legs.push({
            tick: str(ticks[i] !== undefined ? ticks[i] : ''),
            amount: str(amounts[i] !== undefined ? amounts[i] : ''),
            memo: perLegMemo ? str(memos[i] !== undefined ? memos[i] : '') : '',
        });
    }
    const sharedMemo = perLegMemo ? '' : str(p.MEMO);
    const anyMemo = sharedMemo || legs.map((l) => l.memo).join('');

    return {
        summary: `Destroy${chainSuffix}: ${legs.map((l) => `${l.amount || '?'} ${l.tick || '?'}`).join(', ')}`,
        details: [
            ...legs.flatMap((l, i) => [
                { label: `Burn ${i + 1}`, value: `${l.amount || '?'} ${l.tick || '?'}` },
                ...(l.memo ? [{ label: '  Memo', value: l.memo }] : []),
            ]),
            ...(sharedMemo ? [{ label: 'Memo', value: sharedMemo }] : []),
        ],
        warnings: [
            'Destroying is irreversible. The tokens cannot be recovered.',
            ...(legs.some((l) => !l.tick) ? ['One or more token tickers are empty.'] : []),
            ...(legs.some((l) => !l.amount || Number(l.amount) <= 0)
                ? ['One or more amounts are not positive.']
                : []),
            ...(anyMemo && /[|;]/.test(anyMemo)
                ? ['A memo contains | or ;: the protocol will reject this transaction.']
                : []),
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

    if (version === '7') {
        // Bridgeability opt-in (xchain-token-bridge.md section 7). Without this
        // branch a v7 fell through to the v0 create-or-update path below and read
        // "Configure token FUFU": a confirm screen that says nothing about opting
        // the token into cross-chain movement, and nothing about LOCK_BRIDGE, which
        // freezes both fields for the life of the token.
        const chains = str(p.BRIDGE_CHAINS);
        const minDepth = str(p.MIN_DEPTH);
        const lockBridge = str(p.LOCK_BRIDGE) === '1';
        // '-' is the clear sentinel; an EMPTY field means "leave unchanged", which
        // is why a caller can never clear a list with ''.
        const clearing = chains === '-';
        return {
            summary: clearing
                ? `Disable bridging for ${tick || '?'}${chainSuffix}`
                : chains
                    ? `Allow ${tick || '?'} to bridge to ${chains}${chainSuffix}`
                    : `Update bridge settings of ${tick || '?'}${chainSuffix}`,
            details: [
                { label: 'Token', value: tick },
                ...(chains
                    ? [{ label: 'Bridgeable to', value: clearing ? 'nothing (bridging off)' : chains }]
                    : []),
                ...(minDepth ? [{ label: 'Minimum confirmations', value: minDepth }] : []),
                ...(lockBridge ? [{ label: 'Lock bridge settings', value: 'yes' }] : []),
                ...(memo ? [{ label: 'Memo', value: memo }] : []),
            ],
            warnings: [
                ...(lockBridge
                    ? ['Locking is permanent. The bridge chains and minimum confirmations '
                        + 'cannot be changed after this transaction confirms.']
                    : []),
                ...(!clearing && chains
                    ? ['Holders will be able to move this token to the named chains, '
                        + 'where its supply is a bridged copy this chain does not control.']
                    : []),
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

module.exports = { decodeMint, decodeDestroy, decodeIssue };
