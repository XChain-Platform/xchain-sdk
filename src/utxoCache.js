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
 * XChain Platform SDK - UTXO Cache
 *
 * In-memory UTXO tracker that prevents double-spend when sending
 * rapid sequential transactions from the same address.
 *
 ********************************************************************/


class UTXOCache {

    constructor() {
        this._utxos   = [];          // cached UTXO set from last refresh
        this._spent   = new Set();   // "txid:vout" strings of UTXOs already used
        this._speculative = [];      // change UTXOs from recently broadcast transactions
        this._address = null;
        this._stale   = true;        // true until first refresh
    }

    // Load/refresh UTXOs from the encoder's UTXO tracker
    // encoder = EncoderClient instance
    async refresh(address, encoder) {
        if (address !== this._address) {
            this._address = address;
            this._spent.clear();
            this._speculative = [];
        }

        let result = await encoder.getUTXOs(address);
        this._utxos = result.utxos || result || [];
        this._stale = false;

        // Confirmed UTXOs that we previously tracked as speculative can be removed
        // from the speculative list (they're now in _utxos)
        let confirmedSet = new Set(this._utxos.map(u => u.txid + ':' + u.vout));
        this._speculative = this._speculative.filter(u => !confirmedSet.has(u.txid + ':' + u.vout));

        return this._utxos;
    }

    // Get available UTXOs (confirmed + speculative, minus spent)
    getAvailable() {
        let all = this._utxos.concat(this._speculative);
        return all.filter(u => !this._spent.has(u.txid + ':' + u.vout));
    }

    // Mark UTXOs as spent after creating a transaction
    // inputs = [{ txid, vout }, ...]
    markSpent(inputs) {
        if (!inputs) return;
        for (let input of inputs) {
            this._spent.add(input.txid + ':' + input.vout);
        }
    }

    // Add a speculative change UTXO from a just-broadcast transaction
    // This lets the next transaction use the change output immediately
    // without waiting for confirmation
    addSpeculative(utxo) {
        if (!utxo || !utxo.txid) return;
        this._speculative.push(utxo);
    }

    // Check if cache has data (not stale)
    isLoaded() {
        return !this._stale;
    }

    // Check if there are available UTXOs
    hasAvailable() {
        return this.getAvailable().length > 0;
    }

    // Full invalidation: forces refresh on next use
    invalidate() {
        this._utxos = [];
        this._spent.clear();
        this._speculative = [];
        this._stale = true;
    }

    // Get the address this cache is tracking
    get address() {
        return this._address;
    }

}

module.exports = UTXOCache;
