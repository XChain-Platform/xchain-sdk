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

const { str, toArray } = require('./value_format.js');

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

/* COLLECT describer: claim accrued validator rewards. */
function decodeCollect(p, chainSuffix) {
    return {
        summary: `Collect validator rewards${chainSuffix}`,
        details: [],
        warnings: [],
    };
}

module.exports = { decodeStake, decodeUnstake, decodeDelegate, decodeVote, decodeDeploy, decodeExecute, decodeContractFunds, decodeCollect };
