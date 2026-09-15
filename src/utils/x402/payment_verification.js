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
const { bn, gte, isPosNum, parseActionString } = require('./amounts.js');

module.exports = {
    // Does this parsed-output / REST-row match the invoice? Exact rules:
    // destination verbatim, tick uppercased, amount >= as BigNumber,
    // memo strict === to the nonce after trim.
    //
    // `ids` (optional, mempool path only) carries the invoice payTo/tick resolved to their
    // numeric index ids, so a raw decoder-mempool output that carries the SDK's compacted
    // `^<id>` wire form (see _findMempoolSend) matches its literal invoice value. The confirmed
    // REST path passes no ids: the explorer has already expanded index ids to canonical
    // address/tick, so those rows only ever match the literal form.
    _outputMatches(invoice, out, ids) {
        const dest   = String(out.destination == null ? '' : out.destination);
        const destOk = dest === invoice.payTo
            || (ids && ids.payToId && dest === '^' + ids.payToId);
        const tick   = String(out.tick).toUpperCase();
        const tickOk = tick === invoice.tick
            || (ids && ids.tickId && tick === '^' + ids.tickId);
        return destOk && tickOk
            && isPosNum(out.amount) && gte(out.amount, invoice.amount)
            && String(out.memo == null ? '' : out.memo).trim() === invoice.nonce;
    },

    // Resolve the invoice's payTo address and tick to their numeric index ids, best-effort and
    // cached by value (payTo/tick are gateway constants). Payments made through the reference
    // X402Client go through the SDK's default `^<id>` address/tick compaction, and the decoder
    // records the raw compacted action string in the mempool `data` column (only the indexer
    // expands ids; the decoder does not). Resolving our own payTo/tick to ids lets the 0-conf
    // matcher accept either the literal or the `^<id>` form. A lookup failure just leaves the id
    // null and falls back to literal-only matching (never throws, never blocks verification).
    async _resolveWireIds(invoice) {
        this._wireIdCache = this._wireIdCache || { addr: new Map(), tick: new Map() };
        const ids = { payToId: null, tickId: null };
        if (!this.explorer) return ids;
        if (this._wireIdCache.addr.has(invoice.payTo)) ids.payToId = this._wireIdCache.addr.get(invoice.payTo);
        else {
            try {
                const res  = await this.explorer.getAddress(invoice.payTo, { noRetry: true });
                const info = res && (Array.isArray(res) ? (res[0] || {}).info : res.info);
                if (info && info.address_id != null && /^[0-9]+$/.test(String(info.address_id))) {
                    ids.payToId = String(info.address_id);
                    this._wireIdCache.addr.set(invoice.payTo, ids.payToId);
                }
            } catch (e) { /* literal-only fallback */ }
        }
        if (this._wireIdCache.tick.has(invoice.tick)) ids.tickId = this._wireIdCache.tick.get(invoice.tick);
        else {
            try {
                const token = await this.explorer.getToken(invoice.tick, { noRetry: true });
                const info  = token && (Array.isArray(token) ? (token[0] || {}).info : token.info);
                if (info && info.tick_id != null && /^[0-9]+$/.test(String(info.tick_id))) {
                    ids.tickId = String(info.tick_id);
                    this._wireIdCache.tick.set(invoice.tick, ids.tickId);
                }
            } catch (e) { /* literal-only fallback */ }
        }
        return ids;
    },

    async _verifySend(proof) {
        const nonce = String(proof.invoice || '');
        const payer = String(proof.payer || '');
        if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, code: 'X402_BAD_INVOICE' };
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };

        // Prove the requester controls `payer` by signing the single-use invoice
        // nonce. Checked before any invoice state read so a mempool watcher who
        // copies a public payer+memo (but lacks the key) cannot front-run the
        // real payer's claim. The nonce is server-issued, fresh and single-use,
        // so it doubles as the signing challenge.
        if (this.requireSignature) {
            const sig = this._verifyPayerSignature(payer, nonce, proof.payerSignature);
            if (!sig.ok) return { ok: false, code: sig.code };
        }

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
    },

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
    },

    async _findMempoolSend(invoice, payer) {
        // Query the mempool by the PAYER (the on-chain source), not payTo. The decoder mempool
        // prefilter matches an `address` query against the source OR any exact pipe-segment of the
        // raw action string; when the payer's SDK compacts the destination to `^<id>` (the default),
        // payTo is not a segment, so a payTo query would never return the row. The payer is always
        // the source, so a payer query returns it regardless of destination compaction. payTo is
        // still enforced below via _outputMatches (literal or resolved `^<id>`).
        const res = await this.explorer.getMempool(payer, 'address', { limit: 100 });
        const rows = (res && res.data) || [];
        const ids = await this._resolveWireIds(invoice);   // for compacted `^<id>` dest/tick matching
        for (const row of rows) {
            if (row.source !== payer) continue;            // anti-frontrun: payer must be the on-chain source
            const parsed = parseActionString(row.data);
            if (!parsed || parsed.action !== 'SEND') continue;
            for (const out of parsed.outputs)
                if (this._outputMatches(invoice, out, ids))
                    return { tx_hash: row.tx_hash };
        }
        return null;
    },

    async _verifyDispenser(proof, resource) {
        const payer = String(proof.payer || '');
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };

        // Prove control of `payer` (else anyone can name someone else's
        // token-holding address and get free access). The payer signs a fresh,
        // resource-bound challenge; the token is one-time-use so a captured
        // (challenge, signature) pair cannot be replayed.
        if (this.requireSignature) {
            const ch = this._checkChallenge(proof.challenge, 'xchain-dispenser', resource);
            if (!ch.ok) return { ok: false, code: ch.code };
            const sig = this._verifyPayerSignature(payer, proof.challenge, proof.payerSignature);
            if (!sig.ok) return { ok: false, code: sig.code };
            const consumed = this._consumeChallenge(ch.nonce, ch.exp);
            if (!consumed.ok) return { ok: false, code: consumed.code };
        }

        const res = await this.explorer.getBalances(payer, { limit: 500 });
        const rows = (res && res.data) || [];
        for (const row of rows) {
            if (String(row.tick).toUpperCase() === this.dispenser.holdTick
                && isPosNum(row.amount) && gte(row.amount, this.dispenser.minBalance))
                return { ok: true, status: 'dispenser_verified', provisional: false };
        }
        return { ok: false, code: 'X402_INSUFFICIENT_HOLDING' };
    },

    /* deposit scheme: confirmed SENDs to depositAddress fund the payer's
       balance; a local ledger records spend. Debit under a per-payer mutex. */

    _ledgerFile(payer) { return path.join(this.deposit.ledgerDir, payer + '.json'); },

    _readLedger(payer) {
        const file = this._ledgerFile(payer);
        if (!fs.existsSync(file)) return { payer, spent: '0', entries: [] };
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { throw new SDKX402Error('X402_STATE_CORRUPT', `deposit ledger ${file} unreadable: ${e.message}`); }
    },

    async _verifyDeposit(proof, resource) {
        const payer = String(proof.payer || '');
        if (!payer) return { ok: false, code: 'X402_NO_PAYER' };

        // Prove control of `payer` before debiting its ledger, else an attacker
        // can name a real depositor and spend THAT depositor's prepaid credit.
        // Consumed one-time so a captured proof cannot re-debit within the TTL.
        if (this.requireSignature) {
            const ch = this._checkChallenge(proof.challenge, 'xchain-deposit', resource);
            if (!ch.ok) return { ok: false, code: ch.code };
            const sig = this._verifyPayerSignature(payer, proof.challenge, proof.payerSignature);
            if (!sig.ok) return { ok: false, code: sig.code };
            const consumed = this._consumeChallenge(ch.nonce, ch.exp);
            if (!consumed.ok) return { ok: false, code: consumed.code };
        }

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
    },
};
