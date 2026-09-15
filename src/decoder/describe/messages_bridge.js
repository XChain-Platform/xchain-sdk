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

const { str } = require('./value_format.js');

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

    if (version === '3') return decodeFeedResult(chainSuffix, actionIndex, value, memo, baseWarnings);
    if (version === '1') return decodeOracleValue(chainSuffix, message, value, fee, memo, baseWarnings);
    if (version === '2') return decodeFeedAnnouncement(chainSuffix, message, fee, memo, baseWarnings);
    return decodePlainBroadcast(chainSuffix, message, value, memo, baseWarnings);
}

function decodeFeedResult(chainSuffix, actionIndex, value, memo, baseWarnings) {
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

function decodeOracleValue(chainSuffix, message, value, fee, memo, baseWarnings) {
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

function decodeFeedAnnouncement(chainSuffix, message, fee, memo, baseWarnings) {
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

function decodePlainBroadcast(chainSuffix, message, value, memo, baseWarnings) {
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
    // PC-29: the unlock threshold. Surfaced in the summary as well as the details
    // because it changes who can read the file, which is the single thing a signer
    // is deciding about here; burying it in a details row would let the most
    // consequential field of a gated publish go unread.
    const minAmount = str(p.GATE_MIN_AMOUNT);
    const gateText = gate
        ? ` (gated by ${gate}${minAmount ? `, min ${minAmount}` : ''})`
        : '';
    return {
        summary: `Publish file ${name || '?'}${chainSuffix}${gateText}`,
        details: [
            { label: 'Name', value: name },
            { label: 'Type', value: type },
            ...(title ? [{ label: 'Title', value: title }] : []),
            ...(gate ? [{ label: 'Gate token', value: gate }] : []),
            ...(minAmount ? [{ label: 'Minimum balance to unlock', value: `${minAmount}${gate ? ` ${gate}` : ''}` }] : []),
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
 * XBRIDGE describer: the cross-chain bridge (xchain-bridge.md section 4,
 * xchain-token-bridge.md section 5). One action name, and the version decides
 * both the leg and the asset:
 *
 *   v0  lock XCHAIN on BTC for a credit on DEST_COIN
 *   v1  burn XCHAIN off BTC for a release back on BTC
 *   v3  lock a general token on its origin chain
 *   v4  burn a bridged <ORIGIN>.<NAME> copy back to its origin chain
 *   v2/v5  the matching SETTLE legs, injected by the indexer from a finalized
 *          bridge_transfers row. A user never broadcasts one (a broadcast v2 is
 *          refused as system-injected) and formats.js deliberately omits both,
 *          so they cannot arrive through decoder.parse. They are still described
 *          here, accurately and as something to refuse, because a confirm screen
 *          that met one and shrugged with the generic fallback would be inviting
 *          a signature on a leg the chain will reject.
 *
 * The warning every user-broadcast leg carries is the one property that makes a
 * bridge different from a send: the funds leave THIS chain, and the credit lands
 * on a chain this screen cannot see or verify. A wrong destination address is
 * unrecoverable, so it is named rather than left to be inferred from the fields.
 */
function decodeXbridge(p, chainSuffix) {
    const version = str(p.VERSION) || '0';
    const amount = str(p.AMOUNT);
    const memo = str(p.MEMO);
    const tick = str(p.TICK);
    const destCoin = str(p.DEST_COIN);
    // Each leg names its counterparty in a different field, never DESTINATION.
    const dest = str(p.DEST_ADDRESS) || str(p.BTC_ADDRESS) || str(p.ORIGIN_ADDRESS);

    const memoWarnings = memo && /[|;]/.test(memo)
        ? ['Memo contains | or ;: the protocol will reject this transaction.']
        : [];

    if (version === '2' || version === '5') {
        return {
            summary: `Bridge settlement leg (system-injected)${chainSuffix}`,
            details: [
                ...(tick ? [{ label: 'Token', value: tick }] : []),
                ...(amount ? [{ label: 'Amount', value: amount }] : []),
                ...(dest ? [{ label: 'Recipient', value: dest }] : []),
            ],
            warnings: [
                'The chain injects this leg itself once a bridge transfer finalizes. '
                    + 'A broadcast one is always rejected, so do not sign it.',
            ],
        };
    }

    const isBurn = version === '1' || version === '4';
    // v0/v1 move the gas token and carry no TICK field; v3/v4 name theirs.
    const asset = tick || 'XCHAIN';

    const summary = isBurn
        ? `Bridge ${amount || '?'} ${asset} back${chainSuffix ? ` from${chainSuffix.slice(3)}` : ''}`
            + ` to ${dest || '?'}`
        : `Bridge ${amount || '?'} ${asset}${chainSuffix} to ${destCoin || '?'} address ${dest || '?'}`;

    return {
        summary,
        details: [
            { label: 'Token', value: asset },
            { label: 'Amount', value: amount },
            ...(destCoin ? [{ label: 'Destination chain', value: destCoin }] : []),
            { label: isBurn ? 'Release to' : 'Credit to', value: dest },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!amount || Number(amount) <= 0 ? ['Amount is not positive.'] : []),
            ...(!dest ? ['Destination address is empty.'] : []),
            ...(!isBurn && !destCoin ? ['Destination chain is empty.'] : []),
            ...memoWarnings,
            isBurn
                ? 'This burns the tokens here and releases them on the other chain. '
                    + 'Check the address: the release cannot be undone or redirected.'
                : 'This locks the tokens here and credits them on another chain. '
                    + 'Check the address and chain: the credit cannot be undone or redirected.',
        ],
    };
}

module.exports = { decodeBroadcast, decodeMessage, decodeFile, decodeLink, decodeSleep, decodeCallback, decodeXbridge };
