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

const fs   = require('fs');
const path = require('path');
const { SDKX402Error } = require('../errors.js');

// Invoice store (single-node, file-backed).

class FileInvoiceStore {
    constructor(dir) {
        this.dir = dir;
        this._locks = new Map();    // nonce -> tail Promise (per-nonce mutex)
    }
    invoicePath(nonce, createdAt) {
        const day = new Date(createdAt).toISOString().slice(0, 10);
        return path.join(this.dir, day, nonce + '.json');
    }
    async locked(nonce, fn) {
        const tail = this._locks.get(nonce) || Promise.resolve();
        const next = tail.then(fn, fn);
        this._locks.set(nonce, next.catch(() => {}));
        return next;
    }
    async create(invoice) {
        const file = this.invoicePath(invoice.nonce, invoice.createdAt);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(invoice));
        fs.renameSync(file + '.tmp', file);
        return invoice;
    }
    // Find by nonce (scan day dirs newest-first; invoices are short-lived).
    find(nonce) {
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
    async get(nonce) { const hit = this.find(nonce); return hit ? hit.invoice : null; }
    // Atomically transition an invoice; mutate() returns the new invoice or
    // throws. Runs under the per-nonce mutex.
    async update(nonce, mutate) {
        return this.locked(nonce, async () => {
            const hit = this.find(nonce);
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

module.exports = FileInvoiceStore;
