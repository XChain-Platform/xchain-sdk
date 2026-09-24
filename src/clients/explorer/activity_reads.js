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
 * XChain Platform SDK - Explorer Client
 *
 * HTTP client wrapping the xchain-explorer REST API endpoints
 *
 ********************************************************************/

const ContractClient = require('../../contract/client.js');

module.exports = {
    async getFiles(query, type, opts = {}) {
        return this.get('/files/' + query + '/' + type, opts);
    },

    // Coin-prefix for a sibling chain at THIS client's network tier:
    // RBTC client + 'DOGE' → 'RDOGE' (token-information-standard.md:
    // cross-chain action refs carry the base ticker; the tier is implied).
    siblingCoin(baseCoin) {
        if (!baseCoin) return this.coin;
        let tier = (this.coin.match(/^([TR])(BTC|LTC|DOGE)$/) || [])[1] || '';
        return tier + String(baseCoin).toUpperCase();
    },

    // Absolute URL of a FILE action's raw bytes on this explorer: the
    // resolution target for TIS `data_ref` entries and on-chain TIS
    // documents (DESCRIPTION = action:<index> / action:<COIN>:<index>).
    // Pass `coin` (base ticker) for a sibling-chain reference. Pure string
    // builder, no request.
    fileRawUrl(actionIndex, coin = null) {
        let base = this.baseUrl.startsWith('http')
            ? this.baseUrl
            : 'http://' + this.baseUrl + ':' + this.port;
        return base.replace(/\/+$/, '') + '/' + this.siblingCoin(coin) + '/api/file/' + String(actionIndex) + '/raw';
    },

    // Fetch the raw ciphertext bytes for a token-gated FILE action by
    // ACTION_INDEX. Returns a Buffer of the encrypted file bytes
    // ([12-byte nonce][ct][16-byte GCM tag]) ready for decryption with
    // the symmetric key from the corresponding MESSAGE handoff.
    // See xchain-documentation/protocol/token-gated-content.md.
    async getGatedFileRaw(actionIndex, coin = null) {
        let url = '/' + this.siblingCoin(coin) + '/api/file/' + actionIndex + '/raw';
        let self = this;
        try {
            if (self.hooks.onRequest)
                self.hooks.onRequest({ service: 'explorer', method: 'GET', url });
            let response = await self.client.get(url, { responseType: 'arraybuffer' });
            if (self.hooks.onResponse)
                self.hooks.onResponse({ service: 'explorer', method: 'GET', url, status: response.status });
            return Buffer.from(response.data);
        } catch (err) {
            if (self.hooks.onError)
                self.hooks.onError({ service: 'explorer', method: 'GET', url, error: err.message });
            self.handleError(err, url);
        }
    },

    async getLinks(query, type, opts = {}) {
        return this.get('/links/' + query + '/' + type, opts);
    },

    async getLists(query, type, opts = {}) {
        return this.get('/lists/' + query + '/' + type, opts);
    },

    async getMessages(query, type, opts = {}) {
        return this.get('/messages/' + query + '/' + type, opts);
    },

    async getMints(query, type, opts = {}) {
        return this.get('/mints/' + query + '/' + type, opts);
    },

    async getOrders(query, type, opts = {}) {
        return this.get('/orders/' + query + '/' + type, opts);
    },

    // Order lifecycle events, type ∈ {block, address}.
    async getOrderCancels(query, type, opts = {}) {
        return this.get('/order_cancels/' + query + '/' + type, opts);
    },

    async getOrderEdits(query, type, opts = {}) {
        return this.get('/order_edits/' + query + '/' + type, opts);
    },

    async getOrderExpires(query, type, opts = {}) {
        return this.get('/order_expires/' + query + '/' + type, opts);
    },

    // Completed order matches (auto-matched counter-orders). The explorer
    // route keys matches by block, so type is 'block'.
    async getOrderMatches(query, type = 'block', opts = {}) {
        if (query)
            return this.get('/order_matches/' + query + '/' + type, opts);
        return this.get('/order_matches', opts);
    },

    async getSends(query, type, opts = {}) {
        return this.get('/sends/' + query + '/' + type, opts);
    },

    async getSleeps(query, type, opts = {}) {
        return this.get('/sleeps/' + query + '/' + type, opts);
    },

    async getSwaps(query, type, opts = {}) {
        return this.get('/swaps/' + query + '/' + type, opts);
    },

    // Swap lifecycle events, type ∈ {block, address}.
    async getSwapCancels(query, type, opts = {}) {
        return this.get('/swap_cancels/' + query + '/' + type, opts);
    },

    async getSwapEdits(query, type, opts = {}) {
        return this.get('/swap_edits/' + query + '/' + type, opts);
    },

    async getSwapExpires(query, type, opts = {}) {
        return this.get('/swap_expires/' + query + '/' + type, opts);
    },

    // Completed swap matches (two auto-matched counter-swaps). The explorer
    // route keys matches by block, so type is 'block'.
    async getSwapMatches(query, type = 'block', opts = {}) {
        if (query)
            return this.get('/swap_matches/' + query + '/' + type, opts);
        return this.get('/swap_matches', opts);
    },

    async getSweeps(query, type, opts = {}) {
        return this.get('/sweeps/' + query + '/' + type, opts);
    },


    /*
     *  Price Methods
     */

    // PRICE v0 validator COIN/FIAT snapshots + v1 user TOKEN/FIAT oracle,
    // type ∈ {block, address, source, token}.
    async getPrices(query, type, opts = {}) {
        if (query)
            return this.get('/prices/' + query + '/' + type, opts);
        return this.get('/prices', opts);
    },

    // Oracle price-snapshot rounds, type ∈ {pair, round, status}.
    async getPriceSnapshots(query, type, opts = {}) {
        if (query)
            return this.get('/price_snapshots/' + query + '/' + type, opts);
        return this.get('/price_snapshots', opts);
    },


    /*
     *  Contract / VM Methods
     */

    async getContract(contractActionIndex) {
        return this.get('/contract/' + contractActionIndex);
    },

    // Read a contract's declared permissions manifest (programmable policy layer),
    // normalized to camelCase for JS/wallet consumers. The explorer serves the
    // manifest as snake_case fields on the /contract/{idx} response
    // (`permissions`: string[]|null, `max_take_bps`: number|null). Returns
    //   { permissions: string[]|null, maxTakeBps: number|null }
    // permissions=null → no declared allowlist (unrestricted); maxTakeBps=null →
    // the global cap applies.
    async getContractManifest(contractActionIndex) {
        let info = await this.getContract(contractActionIndex);
        return ContractClient.parseManifest(info);
    },

    async getContracts(query, type, opts = {}) {
        if (query)
            return this.get('/contracts/' + query + '/' + type, opts);
        return this.get('/contracts', opts);
    },

    async getContractState(contractActionIndex, key) {
        if (key)
            return this.get('/contract/' + contractActionIndex + '/state/' + key);
        return this.get('/contract/' + contractActionIndex + '/state');
    },

    async getContractBalance(contractActionIndex, tick) {
        if (tick)
            return this.get('/contract/' + contractActionIndex + '/balance/' + tick);
        return this.get('/contract/' + contractActionIndex + '/balance');
    },

    async getExecution(executionActionIndex) {
        return this.get('/execution/' + executionActionIndex);
    },

    // The explorer's filtered executions route is /executions/{QUERY}/{TYPE}
    // (type in block|address|contract); the type segment is required, so a
    // query-only path 404s. Thread type like the sibling helpers (getContracts,
    // getContractStakes), defaulting to 'contract' (the common: list a contract's
    // executions by its action index).
    async getExecutions(query, type = 'contract', opts = {}) {
        if (query)
            return this.get('/executions/' + query + '/' + type, opts);
        return this.get('/executions', opts);
    },

    async getDeposits(query, type, opts = {}) {
        return this.get('/deposits/' + query + '/' + type, opts);
    },

    async getWithdrawals(query, type, opts = {}) {
        return this.get('/withdrawals/' + query + '/' + type, opts);
    },
};
