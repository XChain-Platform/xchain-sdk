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

const { SDKX402Error } = require('../errors.js');
const AuthUtils = require('../auth.js');
const { gte, DEFAULT_MAX_AMOUNT, X402_VERSION, signForAddress } = require('./amounts.js');

// Client side.

class X402Client {

    // session: a WalletSession/AgentSession bound to the paying key.
    // The client enforces `maxAmount` ITSELF before calling session.send: the
    // remote server names the amount, tick and destination, so the ceiling must
    // not depend on the caller happening to pass a policy-bearing AgentSession
    // (a plain WalletSession carries no ceiling). Omitting maxAmount applies a
    // conservative default (DEFAULT_MAX_AMOUNT); unbounded spending is an
    // explicit opt-in via maxAmount: 'unbounded' / Infinity or allowUnbounded.
    constructor(options = {}) {
        if (!options.session) throw new SDKX402Error('X402_CONFIG', 'session (WalletSession/AgentSession) is required');
        this.session  = options.session;
        this.fetch    = options.fetch || (typeof fetch === 'function' ? fetch : null);
        if (!this.fetch) throw new SDKX402Error('X402_CONFIG', 'no fetch implementation available');
        // Fail-closed default ceiling. null means "unbounded" and is reachable
        // only by an explicit opt-in, never by omission.
        if (options.allowUnbounded === true
            || options.maxAmount === 'unbounded' || options.maxAmount === Infinity) {
            this.maxAmount = null;
        } else if (options.maxAmount === undefined || options.maxAmount === null) {
            this.maxAmount = DEFAULT_MAX_AMOUNT;
        } else {
            this.maxAmount = String(options.maxAmount);
        }
        this.retryDelayMs = options.retryDelayMs || 1500;
        this.maxRetries   = options.maxRetries || 40;
        // Network for the payer message signature. Falls back to the SDK the
        // session was built from.
        this.network = options.network
            || (this.session.sdk && this.session.sdk.options && this.session.sdk.options.network)
            || null;
        this._auth = new AuthUtils(this.network || undefined);
    }

    // Sign `message` with the session key so it verifies against the payer
    // address. Throws (via signForAddress) if no network is resolvable.
    sign(message) {
        return signForAddress(this._auth, message, this.session.wif, this.session.address, this.network || undefined);
    }

    // Build a signed dispenser/deposit proof header from a 402 `accepts` offer.
    // The send scheme is handled inline by fetchUrl; dispenser/deposit are paid
    // out of band (buy from the dispenser / deposit up front), so callers build
    // their proof with this and attach it as the X-Payment header themselves.
    static buildSignedProof(offer, session, opts = {}) {
        if (!offer || !offer.scheme) throw new SDKX402Error('X402_CONFIG', 'a 402 accepts offer is required');
        const network = opts.network
            || (session.sdk && session.sdk.options && session.sdk.options.network) || undefined;
        const auth = new AuthUtils(network);
        const proof = { x402Version: X402_VERSION, scheme: offer.scheme, coin: offer.coin, payer: session.address };
        if (offer.requireSignature) {
            if (!offer.challenge) throw new SDKX402Error('X402_CONFIG', 'offer.challenge is required to sign a ' + offer.scheme + ' proof');
            proof.challenge = offer.challenge;
            proof.payerSignature = signForAddress(auth, offer.challenge, session.wif, session.address, network);
        }
        return Buffer.from(JSON.stringify(proof)).toString('base64url');
    }

    pickScheme(accepts) {
        // Prefer pay-per-call; deposit/dispenser need prior on-chain setup the
        // caller manages out of band (we still pass their proofs through).
        return accepts.find((a) => a.scheme === 'xchain-send') || null;
    }

    // Build one typed, txid-carrying signal for every post-broadcast ambiguity.
    // Both leak paths -- session.send throwing after the tx is broadcast, and the
    // retry loop exhausting without acceptance -- funnel here. The money may have
    // moved, so the caller must NOT blindly re-enter fetchUrl (that re-pays); the
    // `resume` descriptor lets them re-present the SAME payment via
    // fetchUrl(url, init, { resume }).
    ambiguous(url, resumeDesc, cause) {
        const details = { txid: resumeDesc.txid, paid: true, resource: url, resume: resumeDesc };
        if (cause && (cause.code || cause.message)) details.cause = cause.code || cause.message;
        return new SDKX402Error('X402_PAYMENT_AMBIGUOUS',
            `payment ${resumeDesc.txid} was broadcast but its gateway outcome is unconfirmed`
            + (cause && cause.code ? ` (${cause.code})` : '')
            + `; retry with { resume } to adopt it instead of paying again`, details);
    }

    // Re-present an existing payment (fresh or resumed) to the gateway until it is
    // accepted. Never broadcasts; on exhaustion it surfaces the ambiguous signal
    // carrying the txid so the caller resumes rather than re-pays.
    async presentPayment(url, init, { coin, invoice, txid, requireSignature }) {
        // Prove control of the paying address by signing the single-use invoice
        // nonce, so the gateway can bind the payment to us (and a mempool watcher
        // who copied the public memo cannot front-run the claim).
        const proofBody = {
            x402Version: X402_VERSION, scheme: 'xchain-send', coin,
            txid, invoice, payer: this.session.address,
        };
        if (requireSignature) proofBody.payerSignature = this.sign(invoice);
        const proof = Buffer.from(JSON.stringify(proofBody)).toString('base64url');

        // Retry until the gateway sees the payment (mempool propagation +
        // decoder/explorer polling lag for 0-conf; a block for 1-conf).
        const headers = Object.assign({}, init.headers, { 'X-Payment': proof });
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            const res = await this.fetch(url, Object.assign({}, init, { headers }));
            if (res.status !== 402) return res;
            await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
        throw this.ambiguous(url, { invoice, txid, coin, requireSignature: !!requireSignature });
    }

    // opts.resume = { invoice, txid, coin, requireSignature } from a prior
    // X402_PAYMENT_AMBIGUOUS error (its `details.resume`): adopt that in-flight
    // payment instead of minting a fresh 402 challenge nonce and broadcasting a
    // second payment.
    async fetchUrl(url, init = {}, opts = {}) {
        const resume = opts && opts.resume;
        if (resume) {
            if (!resume.invoice || !resume.txid)
                throw new SDKX402Error('X402_CONFIG', 'resume requires { invoice, txid }');
            // No fresh fetch, no fresh nonce, no session.send: re-present only.
            return this.presentPayment(url, init, {
                coin: resume.coin, invoice: resume.invoice, txid: resume.txid,
                requireSignature: !!resume.requireSignature,
            });
        }

        let res = await this.fetch(url, init);
        if (res.status !== 402) return res;

        const challenge = await res.json();
        const accepts = (challenge && challenge.accepts) || [];
        const offer = this.pickScheme(accepts);
        if (!offer) throw new SDKX402Error('X402_NO_USABLE_SCHEME', 'no xchain-send offer in challenge', { accepts });
        if (this.maxAmount !== null && !gte(this.maxAmount, offer.amount))
            throw new SDKX402Error('X402_PRICE_TOO_HIGH', `offer ${offer.amount} ${offer.tick} exceeds maxAmount ${this.maxAmount}`, { offer });

        // Pay. A refusal BEFORE broadcast (policy denial, bad config) carries no
        // txid and propagates unchanged (SDKPolicyError stays instanceof). A throw
        // AFTER broadcast carries details.txid (CONFIRMATION_TIMEOUT on the indexer
        // wait, a POLICY_DUPLICATE_SUBMIT refusal, a lost ACK): the money may have
        // moved, so convert it to the single ambiguous signal rather than letting a
        // naive retry pay twice.
        const zeroConf = Number(offer.minConfirmations) === 0;
        let payResult;
        try {
            payResult = await this.session.send(
                { tick: offer.tick, amount: offer.amount, destination: offer.payTo, memo: offer.invoice },
                {}, zeroConf ? { waitForIndexer: false } : {});
        } catch (err) {
            const txid = err && err.details && err.details.txid;
            if (txid) throw this.ambiguous(url,
                { invoice: offer.invoice, txid, coin: offer.coin, requireSignature: !!offer.requireSignature }, err);
            throw err;
        }

        return this.presentPayment(url, init, {
            coin: offer.coin, invoice: offer.invoice, txid: payResult.txid,
            requireSignature: offer.requireSignature,
        });
    }
}

module.exports = X402Client;
