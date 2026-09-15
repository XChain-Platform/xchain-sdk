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
 * XChain Platform SDK - x402 payments
 *
 * HTTP 402 "Payment Required" flow settled in XChain tokens: a server
 * answers 402 with a structured challenge, the client pays on-chain
 * (SEND carrying an invoice nonce in the MEMO), retries with an
 * X-Payment proof header, and the server verifies via the explorer.
 * x402-SHAPED (status 402 + accepts array + X-Payment header) but not
 * Coinbase-facilitator-compatible: schemes are XChain-native.
 *
 * Schemes:
 *   xchain-send       pay-per-call: SEND tick/amount to payTo with
 *                     MEMO = invoice nonce. minConfirmations 0 accepts
 *                     mempool visibility (PROVISIONAL: decoder mempool
 *                     rows are pre-validation; a sweeper promotes to
 *                     confirmed or revokes), 1+ requires indexed rows.
 *   xchain-dispenser  hold-to-access: caller holds >= minBalance of
 *                     holdTick (buy from the referenced dispenser).
 *   xchain-deposit    metered: confirmed deposits to depositAddress
 *                     fund a local spend ledger debited per call.
 *
 * Replay rules: invoice nonces are single-use (claimed under a per-nonce
 * mutex + atomic file write); the on-chain SEND's source must equal the
 * proof's payer (anti-frontrun); amounts compare as exact BigNumbers.
 *
 * The file-backed invoice store is SINGLE-NODE. Multi-node deployments
 * must inject an external store via options.invoiceStore.
 *
 ********************************************************************/

'use strict';

const { create, all } = require('mathjs');

const math = create(all, { number: 'BigNumber', precision: 64 });
const bn   = (v) => math.bignumber(String(v));
// Exact decimal comparisons via BigNumber methods. mathjs larger()/equal()
// apply an epsilon tolerance (see agent_session.js).
const gte  = (a, b) => bn(a).gte(bn(b));
// Conservative default per-payment ceiling for X402Client. The client is an
// autonomous on-chain spend effector whose amount/tick/payTo are all named by
// the remote server, so it must be fail-closed by default: absent an explicit
// maxAmount, spending is capped here and truly-unbounded spending is an explicit
// opt-in (maxAmount: 'unbounded' / Infinity, or allowUnbounded: true). The value
// is in base token units; real deployments set an explicit maxAmount for the
// ticks they buy.
const DEFAULT_MAX_AMOUNT = '100';
// Protocol amounts are plain decimal strings; reject exponents, signs,
// unicode digits, anything bignumber would "helpfully" accept.
const isPosNum = (v) => {
    if (!/^\d+(\.\d+)?$/.test(String(v))) return false;
    try { const x = bn(v); return x.isFinite() && x.gt(0); } catch (e) { return false; }
};

const X402_VERSION = 1;

// Payer-signature binding.
// Every proof must prove the requester CONTROLS `payer`, otherwise anyone can
// name a token-holding / depositing address they do not own (free access /
// theft of another payer's prepaid credit) or replay a public invoice memo
// (front-run). The payer signs a fresh, server-issued challenge (the single-use
// invoice nonce for send; an HMAC-authenticated challenge token for
// dispenser/deposit) with its wallet key; the gateway verifies the Bitcoin
// message signature against the payer address.

// Sign `message` with `wif` so the signature verifies against `address`. The
// message-signature header byte encodes the address type, so a p2pkh key must
// sign in p2pkh mode, a bech32 key in p2wpkh mode, etc. Try each mode and keep
// the one whose derived address matches; fall back to p2pkh.
function signForAddress(auth, message, wif, address, network) {
    for (const opts of [{}, { segwitNative: true }, { segwitRedeemScript: true }]) {
        try {
            const r = auth.signMessage(message, wif, Object.assign({ network }, opts));
            if (r.address === address) return r.signature;
        } catch (e) { /* try the next address type */ }
    }
    return auth.signMessage(message, wif, { network }).signature;
}

// Shared: action-string parsing.

// Wire layout (verified against FormatSelector.serialize): pipe-joined with
// the action name first, e.g. SEND|0|TICK|AMOUNT|DESTINATION|MEMO.
// SEND output tuples per version; index maps into the segment array.
const SEND_LAYOUTS = {
    0: { count: 6,  outputs: [{ tick: 2, amount: 3, destination: 4, memo: 5 }] },
    1: { count: 8,  outputs: [{ tick: 2, amount: 3, destination: 4, memo: 7 },
                              { tick: 2, amount: 5, destination: 6, memo: 7 }] },
    2: { count: 9,  outputs: [{ tick: 2, amount: 3, destination: 4, memo: 8 },
                              { tick: 5, amount: 6, destination: 7, memo: 8 }] },
    3: { count: 10, outputs: [{ tick: 2, amount: 3, destination: 4, memo: 5 },
                              { tick: 6, amount: 7, destination: 8, memo: 9 }] },
};

// Parse a decoded action string. For SEND, returns per-output tuples with the
// CORRECT amount/memo paired to each destination (multi-output v1–v3 must not
// let an attacker match payTo against one output and an amount from another).
// Returns null on anything malformed; non-SEND actions return empty outputs.
function parseActionString(text) {
    if (typeof text !== 'string' || !text.length) return null;
    const segments = text.normalize('NFC').split('|');
    const action = String(segments[0] || '').trim().toUpperCase();
    if (!/^[A-Z_]{2,32}$/.test(action)) return null;
    const version = String(segments[1] || '').trim();
    if (action !== 'SEND') return { action, version, outputs: [] };

    const layout = SEND_LAYOUTS[Number(version)];
    if (!layout || segments.length !== layout.count) return null;   // strict count: pipes in memo can't shift fields
    const outputs = [];
    for (const map of layout.outputs) {
        const amount = segments[map.amount];
        if (!isPosNum(amount)) return null;
        outputs.push({
            tick:        String(segments[map.tick] || '').toUpperCase(),
            amount:      String(amount),
            destination: String(segments[map.destination] || ''),   // addresses compare verbatim
            memo:        String(segments[map.memo] || '').trim(),
        });
    }
    return { action, version, outputs };
}

module.exports = {
    math, bn, gte, DEFAULT_MAX_AMOUNT, isPosNum, X402_VERSION,
    signForAddress, SEND_LAYOUTS, parseActionString,
};
