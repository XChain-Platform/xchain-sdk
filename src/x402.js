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

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { create, all } = require('mathjs');
const { SDKX402Error } = require('./errors.js');

const math = create(all, { number: 'BigNumber', precision: 64 });
const bn   = (v) => math.bignumber(String(v));
// Exact decimal comparisons via BigNumber methods. mathjs larger()/equal()
// apply an epsilon tolerance (see agentSession.js).
const gte  = (a, b) => bn(a).gte(bn(b));
// Protocol amounts are plain decimal strings; reject exponents, signs,
// unicode digits, anything bignumber would "helpfully" accept.
const isPosNum = (v) => {
    if (!/^\d+(\.\d+)?$/.test(String(v))) return false;
    try { const x = bn(v); return x.isFinite() && x.gt(0); } catch (e) { return false; }
};

const X402_VERSION = 1;

/* ── shared: action-string parsing ──────────────────────────────────── */

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

/* ── invoice store (single-node, file-backed) ───────────────────────── */

class FileInvoiceStore {
    constructor(dir) {
        this.dir = dir;
        this._locks = new Map();    // nonce -> tail Promise (per-nonce mutex)
    }
    _file(nonce, createdAt) {
        const day = new Date(createdAt).toISOString().slice(0, 10);
        return path.join(this.dir, day, nonce + '.json');
    }
    async _locked(nonce, fn) {
        const tail = this._locks.get(nonce) || Promise.resolve();
        const next = tail.then(fn, fn);
        this._locks.set(nonce, next.catch(() => {}));
        return next;
    }
    async create(invoice) {
        const file = this._file(invoice.nonce, invoice.createdAt);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(invoice));
        fs.renameSync(file + '.tmp', file);
        return invoice;
    }
    // Find by nonce (scan day dirs newest-first; invoices are short-lived).
    _find(nonce) {
        if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
        if (!fs.existsSync(this.dir)) return null;
        for (const day of fs.readdirSync(this.dir).sort().reverse()) {
            const file = path.join(this.dir, day, nonce + '.json');
            if (fs.existsSync(file)) {
                try { return { file, invoice: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
                catch (e) { throw new SDKX402Error('X402_STATE_CORRUPT', `invoice file ${file} unreadable: ${e.message}`); }
            }
        }
        return null;
    }
    async get(nonce) { const hit = this._find(nonce); return hit ? hit.invoice : null; }
    // Atomically transition an invoice; mutate() returns the new invoice or
    // throws. Runs under the per-nonce mutex.
    async update(nonce, mutate) {
        return this._locked(nonce, async () => {
            const hit = this._find(nonce);
            if (!hit) return null;
            const updated = await mutate(hit.invoice);
            fs.writeFileSync(hit.file + '.tmp', JSON.stringify(updated));
            fs.renameSync(hit.file + '.tmp', hit.file);
            return updated;
        });
    }
    // All invoices in a given status (sweeper).
    async listByStatus(status) {
        const out = [];
        if (!fs.existsSync(this.dir)) return out;
        for (const day of fs.readdirSync(this.dir)) {
            const dayDir = path.join(this.dir, day);
            if (!fs.statSync(dayDir).isDirectory()) continue;
            for (const f of fs.readdirSync(dayDir)) {
                if (!f.endsWith('.json')) continue;
                try {
                    const inv = JSON.parse(fs.readFileSync(path.join(dayDir, f), 'utf8'));
                    if (inv.status === status) out.push(inv);
                } catch (e) { /* corrupt entries surface on direct access, not sweeps */ }
            }
        }
        return out;
    }
    // Drop day-partitions older than maxAgeDays.
    async prune(maxAgeDays) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
        for (const day of fs.readdirSync(this.dir))
            if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff)
                fs.rmSync(path.join(this.dir, day), { recursive: true, force: true });
    }
}

/* ── gateway (server side) ──────────────────────────────────────────── */

class X402Gateway {

    constructor(options = {}) {
        const o = options;
        if (!o.coin) throw new SDKX402Error('X402_CONFIG', 'coin is required');
        if (!o.explorer) throw new SDKX402Error('X402_CONFIG', 'explorer (an SDK ExplorerClient or compatible) is required');
        this.coin     = String(o.coin).toUpperCase();
        this.explorer = o.explorer;

        this.send = o.send ? {
            tick:             String(o.send.tick).toUpperCase(),
            amount:           String(o.send.amount),
            payTo:            String(o.send.payTo),
            minConfirmations: o.send.minConfirmations !== undefined ? Number(o.send.minConfirmations) : 1,
            ttlMs:            o.send.ttlMs || 5 * 60 * 1000,
        } : null;
        if (this.send && (!isPosNum(this.send.amount) || !this.send.tick || !this.send.payTo))
            throw new SDKX402Error('X402_CONFIG', 'send scheme requires tick, positive amount, payTo');

        this.dispenser = o.dispenser ? {
            holdTick:         String(o.dispenser.holdTick).toUpperCase(),
            minBalance:       String(o.dispenser.minBalance || '1'),
            dispenserIndex:   o.dispenser.dispenserIndex,
            dispenserAddress: o.dispenser.dispenserAddress || null,
        } : null;

        this.deposit = o.deposit ? {
            tick:           String(o.deposit.tick).toUpperCase(),
            depositAddress: String(o.deposit.depositAddress),
            pricePerCall:   String(o.deposit.pricePerCall),
            ledgerDir:      o.deposit.ledgerDir || path.join(o.stateDir || '.x402', 'deposits', this.coin),
        } : null;
        if (this.deposit && !isPosNum(this.deposit.pricePerCall))
            throw new SDKX402Error('X402_CONFIG', 'deposit scheme requires a positive pricePerCall');

        if (!this.send && !this.dispenser && !this.deposit)
            throw new SDKX402Error('X402_CONFIG', 'at least one scheme (send, dispenser, deposit) must be configured');

        this.store = o.invoiceStore
            || new FileInvoiceStore(path.join(o.stateDir || '.x402', 'invoices', this.coin));
        this.confirmWindowMs     = o.confirmWindowMs || 10 * 60 * 1000;
        this.expiryGraceMs       = o.expiryGraceMs || 10 * 1000;
        this.onProvisionalFailed = o.onProvisionalFailed || null;
        this.description         = o.description || 'Payment required';
        this._depositLocks       = new Map();
        this._sweepTimer         = null;
    }

    /* ── challenge ── */

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
            });
        }
        if (this.dispenser)
            accepts.push({
                scheme: 'xchain-dispenser', coin: this.coin,
                holdTick: this.dispenser.holdTick, minBalance: this.dispenser.minBalance,
                dispenserIndex: this.dispenser.dispenserIndex,
                dispenserAddress: this.dispenser.dispenserAddress,
            });
        if (this.deposit)
            accepts.push({
                scheme: 'xchain-deposit', coin: this.coin,
                tick: this.deposit.tick, depositAddress: this.deposit.depositAddress,
                pricePerCall: this.deposit.pricePerCall,
            });
        return { x402Version: X402_VERSION, error: this.description, resource: resource || null, accepts };
    }

    /* ── verification ── */

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
        if (proof.scheme === 'xchain-send' && this.send)            return this._verifySend(proof);
        if (proof.scheme === 'xchain-dispenser' && this.dispenser)  return this._verifyDispenser(proof);
        if (proof.scheme === 'xchain-deposit' && this.deposit)      return this._verifyDeposit(proof, resource);
        return { ok: false, code: 'X402_UNSUPPORTED_SCHEME' };
    }

    // Does this parsed-output / REST-row match the invoice? Exact rules:
    // destination verbatim, tick uppercased, amount >= as BigNumber,
    // memo strict === to the nonce after trim.
    _outputMatches(invoice, out) {
        return out.destination === invoice.payTo
            && String(out.tick).toUpperCase() === invoice.tick
            && isPosNum(out.amount) && gte(out.amount, invoice.amount)
            && String(out.memo == null ? '' : out.memo).trim() === invoice.nonce;
    }

    async _verifySend(proof) {
        const nonce = String(proof.invoice || '');
        const payer = String(proof.payer || '');
        if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, code: 'X402_BAD_INVOICE' };
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };

        const invoice = await this.store.get(nonce);
        if (!invoice) return { ok: false, code: 'X402_UNKNOWN_INVOICE' };
        if (['used', 'confirmed', 'provisional_0conf'].includes(invoice.status))
            return { ok: false, code: 'X402_INVOICE_ALREADY_USED' };
        if (Date.now() > invoice.expiresAt + this.expiryGraceMs)
            return { ok: false, code: 'X402_INVOICE_EXPIRED' };

        // Confirmed path first (strongest evidence).
        const confirmed = await this._findConfirmedSend(invoice, payer);
        if (confirmed) {
            const updated = await this.store.update(nonce, (inv) => {
                if (['used', 'confirmed', 'provisional_0conf'].includes(inv.status))
                    throw new SDKX402Error('X402_INVOICE_ALREADY_USED', 'invoice already claimed');
                return Object.assign({}, inv, { status: 'confirmed', payer, txid: confirmed.tx_hash, blockIndex: confirmed.block_index, usedAt: Date.now() });
            }).catch((e) => { if (e.code === 'X402_INVOICE_ALREADY_USED') return null; throw e; });
            if (!updated) return { ok: false, code: 'X402_INVOICE_ALREADY_USED' };
            return { ok: true, status: 'confirmed', provisional: false, txid: confirmed.tx_hash, blockIndex: confirmed.block_index };
        }

        // 0-conf path (only when the invoice allows it): decoder mempool rows,
        // parsed with full multi-output pairing. PRE-VALIDATION (provisional).
        if (invoice.minConfirmations === 0) {
            const hit = await this._findMempoolSend(invoice, payer);
            if (hit) {
                const updated = await this.store.update(nonce, (inv) => {
                    if (['used', 'confirmed', 'provisional_0conf'].includes(inv.status))
                        throw new SDKX402Error('X402_INVOICE_ALREADY_USED', 'invoice already claimed');
                    return Object.assign({}, inv, { status: 'provisional_0conf', payer, txid: hit.tx_hash, grantedAt: Date.now() });
                }).catch((e) => { if (e.code === 'X402_INVOICE_ALREADY_USED') return null; throw e; });
                if (!updated) return { ok: false, code: 'X402_INVOICE_ALREADY_USED' };
                return { ok: true, status: 'provisional_0conf', provisional: true, txid: hit.tx_hash };
            }
        }
        return { ok: false, code: 'X402_PAYMENT_NOT_FOUND' };
    }

    async _findConfirmedSend(invoice, payer) {
        const res = await this.explorer.getSends(invoice.payTo, 'destination', { limit: 100 });
        const rows = (res && res.data) || [];
        for (const row of rows) {
            if (row.source !== payer) continue;
            if (row.status && String(row.status).toLowerCase() !== 'valid') continue;
            if (this._outputMatches(invoice, { tick: row.tick, amount: row.amount, destination: row.destination || invoice.payTo, memo: row.memo }))
                return row;
        }
        return null;
    }

    async _findMempoolSend(invoice, payer) {
        const res = await this.explorer.getMempool(invoice.payTo, 'address', { limit: 100 });
        const rows = (res && res.data) || [];
        for (const row of rows) {
            if (row.source !== payer) continue;            // anti-frontrun: payer must be the on-chain source
            const parsed = parseActionString(row.data);
            if (!parsed || parsed.action !== 'SEND') continue;
            for (const out of parsed.outputs)
                if (this._outputMatches(invoice, out))
                    return { tx_hash: row.tx_hash };
        }
        return null;
    }

    async _verifyDispenser(proof) {
        const payer = String(proof.payer || '');
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };
        const res = await this.explorer.getBalances(payer, { limit: 500 });
        const rows = (res && res.data) || [];
        for (const row of rows) {
            if (String(row.tick).toUpperCase() === this.dispenser.holdTick
                && isPosNum(row.amount) && gte(row.amount, this.dispenser.minBalance))
                return { ok: true, status: 'dispenser_verified', provisional: false };
        }
        return { ok: false, code: 'X402_INSUFFICIENT_HOLDING' };
    }

    /* deposit scheme: confirmed SENDs to depositAddress fund the payer's
       balance; a local ledger records spend. Debit under a per-payer mutex. */

    _ledgerFile(payer) { return path.join(this.deposit.ledgerDir, payer + '.json'); }

    _readLedger(payer) {
        const file = this._ledgerFile(payer);
        if (!fs.existsSync(file)) return { payer, spent: '0', entries: [] };
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { throw new SDKX402Error('X402_STATE_CORRUPT', `deposit ledger ${file} unreadable: ${e.message}`); }
    }

    async _verifyDeposit(proof, resource) {
        const payer = String(proof.payer || '');
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };
        const tail = this._depositLocks.get(payer) || Promise.resolve();
        const run = tail.then(async () => {
            const res = await this.explorer.getSends(this.deposit.depositAddress, 'destination', { limit: 100 });
            const rows = (res && res.data) || [];
            let deposited = bn(0);
            for (const row of rows)
                if (row.source === payer
                    && String(row.tick).toUpperCase() === this.deposit.tick
                    && (!row.status || String(row.status).toLowerCase() === 'valid')
                    && isPosNum(row.amount))
                    deposited = deposited.plus(bn(row.amount));
            const ledger = this._readLedger(payer);
            const available = deposited.minus(bn(ledger.spent));
            if (!gte(available.toString(), this.deposit.pricePerCall))
                return { ok: false, code: 'X402_DEPOSIT_EXHAUSTED', available: available.toString() };
            ledger.spent = bn(ledger.spent).plus(bn(this.deposit.pricePerCall)).toString();
            ledger.entries.push({ t: Date.now(), amount: this.deposit.pricePerCall, resource: resource || null });
            fs.mkdirSync(path.dirname(this._ledgerFile(payer)), { recursive: true });
            fs.writeFileSync(this._ledgerFile(payer) + '.tmp', JSON.stringify(ledger));
            fs.renameSync(this._ledgerFile(payer) + '.tmp', this._ledgerFile(payer));
            return { ok: true, status: 'deposit_debited', provisional: false, remaining: available.minus(bn(this.deposit.pricePerCall)).toString() };
        });
        this._depositLocks.set(payer, run.catch(() => {}));
        return run;
    }

    /* ── provisional sweeper ── */

    // Re-check provisional_0conf grants: promote on confirmation, mark failed
    // (+ notify the operator) once the window closes without one.
    async sweep() {
        const provisional = await this.store.listByStatus('provisional_0conf');
        for (const inv of provisional) {
            try {
                const confirmed = await this._findConfirmedSend(Object.assign({}, inv, { status: 'pending' }), inv.payer);
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
                // log it: a consistently-throwing _findConfirmedSend/store.update leaves a
                // genuinely-paid invoice stuck in provisional_0conf forever (never promoted,
                // never failed, no operator notification) while the loop looks healthy.
                console.error('x402 sweep: invoice ' + inv.nonce + ' (payer ' + inv.payer + ') failed this cycle:', e);
            }
        }
    }

    startSweeper(intervalMs) {
        if (this._sweepTimer) return;
        this._sweepTimer = setInterval(() => {
            // A whole-sweep failure (e.g. listByStatus throwing) must not crash the timer,
            // but log it instead of eating it so a stuck sweeper is visible after one cycle.
            this.sweep().catch((e) => console.error('x402 sweep: cycle failed:', e));
        }, intervalMs || 30000);
        if (this._sweepTimer.unref) this._sweepTimer.unref();
    }
    stopSweeper() { if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; } }

    /* ── HTTP adapters ── */

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

/* ── client side ────────────────────────────────────────────────────── */

class X402Client {

    // session: a WalletSession/AgentSession bound to the paying key.
    // Pays through session.send(), so AgentSession policies apply naturally.
    constructor(options = {}) {
        if (!options.session) throw new SDKX402Error('X402_CONFIG', 'session (WalletSession/AgentSession) is required');
        this.session  = options.session;
        this.fetch    = options.fetch || (typeof fetch === 'function' ? fetch : null);
        if (!this.fetch) throw new SDKX402Error('X402_CONFIG', 'no fetch implementation available');
        this.maxAmount   = options.maxAmount !== undefined ? String(options.maxAmount) : null;
        this.retryDelayMs = options.retryDelayMs || 1500;
        this.maxRetries   = options.maxRetries || 40;
    }

    _pickScheme(accepts) {
        // Prefer pay-per-call; deposit/dispenser need prior on-chain setup the
        // caller manages out of band (we still pass their proofs through).
        return accepts.find((a) => a.scheme === 'xchain-send') || null;
    }

    async fetchUrl(url, init = {}) {
        let res = await this.fetch(url, init);
        if (res.status !== 402) return res;

        const challenge = await res.json();
        const accepts = (challenge && challenge.accepts) || [];
        const offer = this._pickScheme(accepts);
        if (!offer) throw new SDKX402Error('X402_NO_USABLE_SCHEME', 'no xchain-send offer in challenge', { accepts });
        if (this.maxAmount !== null && !gte(this.maxAmount, offer.amount))
            throw new SDKX402Error('X402_PRICE_TOO_HIGH', `offer ${offer.amount} ${offer.tick} exceeds maxAmount ${this.maxAmount}`, { offer });

        // Pay. SDKPolicyError from an AgentSession propagates; refusals are final.
        const zeroConf = Number(offer.minConfirmations) === 0;
        const payResult = await this.session.send(
            { tick: offer.tick, amount: offer.amount, destination: offer.payTo, memo: offer.invoice },
            {}, zeroConf ? { waitForIndexer: false } : {});

        const proof = Buffer.from(JSON.stringify({
            x402Version: X402_VERSION, scheme: 'xchain-send', coin: offer.coin,
            txid: payResult.txid, invoice: offer.invoice, payer: this.session.address,
        })).toString('base64url');

        // Retry until the gateway sees the payment (mempool propagation +
        // decoder/explorer polling lag for 0-conf; a block for 1-conf).
        const headers = Object.assign({}, init.headers, { 'X-Payment': proof });
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            res = await this.fetch(url, Object.assign({}, init, { headers }));
            if (res.status !== 402) return res;
            await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
        throw new SDKX402Error('X402_PAYMENT_NOT_ACCEPTED',
            `gateway did not accept payment ${payResult.txid} after ${this.maxRetries} retries`, { txid: payResult.txid });
    }
}

module.exports = { X402Gateway, X402Client, FileInvoiceStore, parseActionString, X402_VERSION };
