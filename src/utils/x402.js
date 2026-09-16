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

const path   = require('path');
const crypto = require('crypto');
const { SDKX402Error } = require('./errors.js');
const AuthUtils = require('./auth.js');
const { isPosNum, parseActionString, X402_VERSION } = require('./x402/amounts.js');
const FileInvoiceStore = require('./x402/file_invoice_store.js');
const X402Client = require('./x402/client.js');
const { getLogger } = require('../observability/logger.js');
const { installMethods } = require('./install_methods.js');
const log = getLogger('xchain-sdk:x402');

function configureSchemes(gateway, o) {
    gateway.send = o.send ? {
        tick:             String(o.send.tick).toUpperCase(),
        amount:           String(o.send.amount),
        payTo:            String(o.send.payTo),
        minConfirmations: o.send.minConfirmations !== undefined ? Number(o.send.minConfirmations) : 1,
        ttlMs:            o.send.ttlMs || 5 * 60 * 1000,
    } : null;
    if (gateway.send && (!isPosNum(gateway.send.amount) || !gateway.send.tick || !gateway.send.payTo))
        throw new SDKX402Error('X402_CONFIG', 'send scheme requires tick, positive amount, payTo');

    gateway.dispenser = o.dispenser ? {
        holdTick:         String(o.dispenser.holdTick).toUpperCase(),
        minBalance:       String(o.dispenser.minBalance || '1'),
        dispenserIndex:   o.dispenser.dispenserIndex,
        dispenserAddress: o.dispenser.dispenserAddress || null,
    } : null;

    gateway.deposit = o.deposit ? {
        tick:           String(o.deposit.tick).toUpperCase(),
        depositAddress: String(o.deposit.depositAddress),
        pricePerCall:   String(o.deposit.pricePerCall),
        ledgerDir:      o.deposit.ledgerDir || path.join(o.stateDir || '.x402', 'deposits', gateway.coin),
    } : null;
    if (gateway.deposit && !isPosNum(gateway.deposit.pricePerCall))
        throw new SDKX402Error('X402_CONFIG', 'deposit scheme requires a positive pricePerCall');

    if (!gateway.send && !gateway.dispenser && !gateway.deposit)
        throw new SDKX402Error('X402_CONFIG', 'at least one scheme (send, dispenser, deposit) must be configured');
}

// Gateway (server side).

class X402Gateway {

    constructor(options = {}) {
        const o = options;
        if (!o.coin) throw new SDKX402Error('X402_CONFIG', 'coin is required');
        if (!o.explorer) throw new SDKX402Error('X402_CONFIG', 'explorer (an SDK ExplorerClient or compatible) is required');
        this.coin     = String(o.coin).toUpperCase();
        this.explorer = o.explorer;

        configureSchemes(this, o);

        this.store = o.invoiceStore
            || new FileInvoiceStore(path.join(o.stateDir || '.x402', 'invoices', this.coin));
        this.confirmWindowMs     = o.confirmWindowMs || 10 * 60 * 1000;
        this.expiryGraceMs       = o.expiryGraceMs || 10 * 1000;
        this.onProvisionalFailed = o.onProvisionalFailed || null;
        this.description         = o.description || 'Payment required';
        this._depositLocks       = new Map();
        this._sweepTimer         = null;

        // Payer-signature binding. Default ON: the proof must carry a signature
        // by `payer` over a fresh server-issued challenge, closing the
        // self-declared-payer holes (free dispenser access, deposit-credit theft,
        // send front-run). Pass requireSignature:false only for a trusted/legacy
        // deployment that gates payer identity some other way.
        this.requireSignature = o.requireSignature !== false;
        this.network          = o.network || null;
        if (this.requireSignature && !this.network)
            throw new SDKX402Error('X402_CONFIG', 'network is required when requireSignature is enabled (used to verify payer message signatures); pass requireSignature:false to disable payer-signature binding');
        this._auth = this.network ? new AuthUtils(this.network) : null;

        // Stateless HMAC secret for dispenser/deposit challenge tokens. send binds
        // to its single-use invoice nonce instead, so it needs no secret. A random
        // per-process secret works but does not survive a restart or validate
        // across nodes, so warn when a schemes-that-need-it gateway omits it.
        this._challengeSecret = o.challengeSecret
            ? (Buffer.isBuffer(o.challengeSecret) ? o.challengeSecret : Buffer.from(String(o.challengeSecret)))
            : crypto.randomBytes(32);
        if (this.requireSignature && !o.challengeSecret && (this.dispenser || this.deposit))
            log.warn('x402: no challengeSecret set; using a random per-process secret. Dispenser/deposit challenges will not survive a restart or work across multiple nodes. Set challengeSecret in production.');
        this.challengeTtlMs   = o.challengeTtlMs || 5 * 60 * 1000;
        this._usedChallenges  = new Map();   // challenge nonce -> expiresAt (one-time-use replay guard)
    }

    // Verification.

    static parseProofHeader(header) {
        try {
            const proof = JSON.parse(Buffer.from(String(header), 'base64url').toString('utf8'));
            if (proof && proof.x402Version === X402_VERSION && proof.scheme) return proof;
        } catch (e) { /* fall through */ }
        return null;
    }

    async verify(proof, resource) {
        if (!proof) return { ok: false, code: 'X402_NO_PROOF' };
        if (proof.coin && String(proof.coin).toUpperCase() !== this.coin)
            return { ok: false, code: 'X402_WRONG_COIN' };
        if (proof.scheme === 'xchain-send' && this.send)            return this.verifySend(proof, resource);
        if (proof.scheme === 'xchain-dispenser' && this.dispenser)  return this.verifyDispenser(proof, resource);
        if (proof.scheme === 'xchain-deposit' && this.deposit)      return this.verifyDeposit(proof, resource);
        return { ok: false, code: 'X402_UNSUPPORTED_SCHEME' };
    }

    // Provisional sweeper.

    // Re-check provisional_0conf grants: promote on confirmation, mark failed
    // (+ notify the operator) once the window closes without one.
    async sweep() {
        const provisional = await this.store.listByStatus('provisional_0conf');
        for (const inv of provisional) {
            try {
                const confirmed = await this.findConfirmedSend(Object.assign({}, inv, { status: 'pending' }), inv.payer);
                if (confirmed) {
                    await this.store.update(inv.nonce, (i) => Object.assign({}, i, { status: 'confirmed', blockIndex: confirmed.block_index, usedAt: i.grantedAt }));
                } else if (Date.now() - inv.grantedAt > this.confirmWindowMs) {
                    const failed = await this.store.update(inv.nonce, (i) => Object.assign({}, i, { status: 'failed_0conf' }));
                    if (failed && this.onProvisionalFailed) {
                        try { this.onProvisionalFailed(failed); } catch (e) { /* observer must not break the sweep */ }
                    }
                }
            } catch (e) {
                // Isolate per-invoice failures so one bad invoice can't stall the sweep, but
                // log it: a consistently-throwing findConfirmedSend/store.update leaves a
                // genuinely-paid invoice stuck in provisional_0conf forever (never promoted,
                // never failed, no operator notification) while the loop looks healthy.
                log.error('x402 sweep: invoice ' + inv.nonce + ' (payer ' + inv.payer + ') failed this cycle:', e);
            }
        }
    }

    startSweeper(intervalMs) {
        if (this._sweepTimer) return;
        this._sweepTimer = setInterval(() => {
            // A whole-sweep failure (e.g. listByStatus throwing) must not crash the timer,
            // but log it instead of eating it so a stuck sweeper is visible after one cycle.
            this.sweep().catch((e) => log.error('x402 sweep: cycle failed:', e));
        }, intervalMs || 30000);
        if (this._sweepTimer.unref) this._sweepTimer.unref();
    }
    stopSweeper() { if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; } }

    // HTTP adapters.

    static buildResponseHeader(result) {
        return Buffer.from(JSON.stringify({
            x402Version: X402_VERSION,
            status: result.status, txid: result.txid || null,
            blockIndex: result.blockIndex || null, provisional: !!result.provisional,
            remaining: result.remaining || undefined,
        })).toString('base64url');
    }

    // Express-style middleware; also works as a guard in a raw http server:
    //   const paid = await gateway.guard(req, res); if (!paid) return;
    middleware() {
        return async (req, res, next) => {
            const paid = await this.guard(req, res);
            if (paid && next) next();
        };
    }

    async guard(req, res) {
        try {
            const header = req.headers && (req.headers['x-payment'] || req.headers['X-Payment']);
            const proof = header ? X402Gateway.parseProofHeader(header) : null;
            const result = proof ? await this.verify(proof, req.url) : null;
            if (result && result.ok) {
                req.x402 = result;
                res.setHeader('X-Payment-Response', X402Gateway.buildResponseHeader(result));
                return true;
            }
            const body = await this.challengeBody(req.url);
            if (result && result.code) body.reason = result.code;
            res.statusCode = 402;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
            return false;
        } catch (e) {
            res.statusCode = e.code === 'X402_STATE_CORRUPT' ? 503 : 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'payment verification error', code: e.code || 'X402_ERROR' }));
            return false;
        }
    }
}

installMethods(X402Gateway.prototype, require('./x402/challenge.js'), require('./x402/payment_verification.js'));

module.exports = { X402Gateway, X402Client, FileInvoiceStore, parseActionString, X402_VERSION };
