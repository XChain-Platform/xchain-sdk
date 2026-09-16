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

const crypto = require('crypto');
const { safeTokenEqual } = require('../safe_compare.js');
const { X402_VERSION } = require('./amounts.js');

module.exports = {
    // Payer-signature helpers.

    // Issue an HMAC-authenticated, expiring challenge token bound to the scheme,
    // coin and resource. Stateless: the MAC lets the gateway trust its own token
    // on the retry without server-side issuance state.
    issueChallenge(scheme, resource) {
        const body = { n: crypto.randomBytes(16).toString('hex'), exp: Date.now() + this.challengeTtlMs,
                       s: scheme, c: this.coin, r: resource == null ? null : String(resource) };
        const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
        const mac = crypto.createHmac('sha256', this._challengeSecret).update(payload).digest('hex');
        return payload + '.' + mac;
    },

    // Validate a challenge token WITHOUT consuming it (MAC, expiry, scheme/coin/
    // resource binding). Returns { ok, nonce, exp } or { ok:false, code }.
    checkChallenge(token, scheme, resource) {
        if (typeof token !== 'string' || token.indexOf('.') < 0) return { ok: false, code: 'X402_CHALLENGE_MISSING' };
        const dot = token.lastIndexOf('.');
        const payload = token.slice(0, dot);
        const mac = token.slice(dot + 1);
        const expect = crypto.createHmac('sha256', this._challengeSecret).update(payload).digest('hex');
        // Shared constant-time comparator: both operands are hex strings, and it
        // equalizes operand length before comparing, so a truncated MAC no longer
        // short-circuits on length. An empty mac fails its non-empty-string guard.
        if (!safeTokenEqual(mac, expect)) return { ok: false, code: 'X402_BAD_CHALLENGE' };
        let body;
        try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
        catch (e) { return { ok: false, code: 'X402_BAD_CHALLENGE' }; }
        if (body.s !== scheme || body.c !== this.coin) return { ok: false, code: 'X402_BAD_CHALLENGE' };
        if ((body.r == null ? null : String(body.r)) !== (resource == null ? null : String(resource)))
            return { ok: false, code: 'X402_CHALLENGE_RESOURCE_MISMATCH' };
        if (!(Number(body.exp) > Date.now())) return { ok: false, code: 'X402_CHALLENGE_EXPIRED' };
        return { ok: true, nonce: body.n, exp: Number(body.exp) };
    },

    // Consume a challenge nonce one time (replay guard). Prunes expired entries so
    // the map stays bounded to the live TTL window.
    consumeChallenge(nonce, exp) {
        const now = Date.now();
        for (const [n, e] of this._usedChallenges) if (e <= now) this._usedChallenges.delete(n);
        if (this._usedChallenges.has(nonce)) return { ok: false, code: 'X402_CHALLENGE_REPLAYED' };
        this._usedChallenges.set(nonce, exp);
        return { ok: true };
    },

    // Verify a Bitcoin message signature by `payer` over `message`.
    verifyPayerSignature(payer, message, signature) {
        if (!this._auth) return { ok: false, code: 'X402_CONFIG' };
        if (typeof signature !== 'string' || !signature) return { ok: false, code: 'X402_SIGNATURE_REQUIRED' };
        let r;
        try { r = this._auth.verifyOwnership(payer, message, signature); }
        catch (e) { return { ok: false, code: 'X402_BAD_SIGNATURE' }; }
        return r.valid ? { ok: true } : { ok: false, code: 'X402_BAD_SIGNATURE' };
    },

    // Challenge.

    async challengeBody(resource) {
        const accepts = [];
        if (this.send) {
            const nonce = crypto.randomBytes(16).toString('hex');
            const now = Date.now();
            const invoice = {
                nonce, scheme: 'xchain-send', coin: this.coin,
                tick: this.send.tick, amount: this.send.amount, payTo: this.send.payTo,
                minConfirmations: this.send.minConfirmations,
                resource: resource || null,
                createdAt: now, expiresAt: now + this.send.ttlMs,
                status: 'pending',
            };
            await this.store.create(invoice);
            accepts.push({
                scheme: 'xchain-send', coin: this.coin,
                tick: this.send.tick, amount: this.send.amount, payTo: this.send.payTo,
                invoice: nonce, expiresAt: invoice.expiresAt,
                minConfirmations: this.send.minConfirmations,
                // send binds the payer signature to the single-use invoice nonce.
                requireSignature: this.requireSignature,
            });
        }
        if (this.dispenser)
            accepts.push({
                scheme: 'xchain-dispenser', coin: this.coin,
                holdTick: this.dispenser.holdTick, minBalance: this.dispenser.minBalance,
                dispenserIndex: this.dispenser.dispenserIndex,
                dispenserAddress: this.dispenser.dispenserAddress,
                requireSignature: this.requireSignature,
                // The payer signs this challenge to prove control of its address.
                challenge: this.requireSignature ? this.issueChallenge('xchain-dispenser', resource) : undefined,
            });
        if (this.deposit)
            accepts.push({
                scheme: 'xchain-deposit', coin: this.coin,
                tick: this.deposit.tick, depositAddress: this.deposit.depositAddress,
                pricePerCall: this.deposit.pricePerCall,
                requireSignature: this.requireSignature,
                challenge: this.requireSignature ? this.issueChallenge('xchain-deposit', resource) : undefined,
            });
        return { x402Version: X402_VERSION, error: this.description, resource: resource || null, accepts };
    },
};
