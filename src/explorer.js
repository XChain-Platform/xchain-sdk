/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Explorer Client
 *
 * HTTP client wrapping the xchain-explorer REST API endpoints
 *
 ********************************************************************/

const axios = require('axios');
const { SDKExplorerError } = require('./errors.js');
const { withRetry, isRetryable } = require('./retry.js');

// Network string → explorer coin prefix mapping
const COIN_PREFIX_MAP = {
    'bitcoin-mainnet':   'BTC',
    'bitcoin-testnet':   'TBTC',
    'bitcoin-regtest':   'RBTC',
    'litecoin-mainnet':  'LTC',
    'litecoin-testnet':  'TLTC',
    'litecoin-regtest':  'RLTC',
    'dogecoin-mainnet':  'DOGE',
    'dogecoin-testnet':  'TDOGE',
    'dogecoin-regtest':  'RDOGE'
};


class ExplorerClient {

    constructor(options = {}) {
        this.baseUrl = options.explorerUrl || 'localhost';
        this.port    = options.explorerPort || 8080;
        this.timeout = options.timeout || 30000;
        this.coin    = this._deriveCoinPrefix(options.network);

        // Connection pooling configuration
        let pool = options.pool || {};
        this._agent = new (require('http').Agent)({
            keepAlive:     pool.keepAlive !== undefined ? pool.keepAlive : true,
            keepAliveMsecs: pool.keepAliveMsecs || 1000,
            maxSockets:    pool.maxSockets || 10,
            maxFreeSockets: pool.maxFreeSockets || 5
        });

        this.client = axios.create({
            baseURL: this.baseUrl.startsWith('http') ? this.baseUrl : 'http://' + this.baseUrl + ':' + this.port,
            timeout: this.timeout,
            headers: { 'Content-Type': 'application/json' },
            httpAgent: this._agent
        });

        // Retry configuration (can be overridden via options)
        this.retry = options.retry !== undefined ? options.retry : {};
        // Hooks
        this.hooks = options.hooks || {};
    }

    // Derive coin prefix from network string
    _deriveCoinPrefix(network) {
        if (!network) return 'BTC';
        let prefix = COIN_PREFIX_MAP[network];
        if (!prefix)
            throw new SDKExplorerError('INVALID_NETWORK', 'Unknown network: ' + network + '. Valid: ' + Object.keys(COIN_PREFIX_MAP).join(', '), { network });
        return prefix;
    }

    // Build query params string from options
    _buildParams(opts = {}) {
        let params = {};
        if (opts.page !== undefined)        params.page = opts.page;
        if (opts.limit !== undefined)       params.limit = opts.limit;
        if (opts.sortorder !== undefined)   params.sortorder = opts.sortorder;
        if (opts.start !== undefined)       params.start = opts.start;
        if (opts.length !== undefined)      params.length = opts.length;
        if (opts.tick !== undefined)        params.tick = opts.tick;
        if (opts.txid !== undefined)        params.txid = opts.txid;
        if (opts.blockIndex !== undefined)  params.blockIndex = opts.blockIndex;
        return params;
    }

    // Make a GET request with retry and hooks
    async _get(path, opts = {}) {
        let url = '/' + this.coin + '/api' + path;
        let self = this;

        let onRetry = this.hooks.onRetry ? (attempt, delay, err) => {
            this.hooks.onRetry({ service: 'explorer', method: 'GET', url, attempt, delay, error: err.message });
        } : null;

        // Disable retry if retry === false
        let retryConfig = this.retry === false ? { maxRetries: 0 } : this.retry;

        try {
            return await withRetry(async () => {
                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'explorer', method: 'GET', url });
                try {
                    let response = await self.client.get(url, { params: self._buildParams(opts) });
                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'explorer', method: 'GET', url, status: response.status });
                    return response.data;
                } catch (err) {
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'explorer', method: 'GET', url, error: err.message });
                    // Re-throw raw error so withRetry can inspect retryability; wrap only when not retryable
                    if (isRetryable(err)) throw err;
                    self._handleError(err, url);
                }
            }, retryConfig, onRetry);
        } catch (err) {
            // After all retries, wrap any raw (non-SDK) error into a typed SDKExplorerError
            if (err instanceof SDKExplorerError) throw err;
            self._handleError(err, url);
        }
    }

    // Handle HTTP errors
    _handleError(err, url) {
        if (err.response) {
            throw new SDKExplorerError(
                'EXPLORER_HTTP_' + err.response.status,
                'Explorer returned HTTP ' + err.response.status + ' for ' + url,
                { url, status: err.response.status, data: err.response.data }
            );
        }
        if (err.code === 'ECONNABORTED') {
            throw new SDKExplorerError('EXPLORER_TIMEOUT', 'Explorer request timed out: ' + url, { url, timeout: this.timeout });
        }
        throw new SDKExplorerError('EXPLORER_NETWORK', 'Explorer request failed: ' + err.message, { url, error: err.message });
    }


    /*
     *  Balance & Address Methods
     */

    async getBalances(address, opts = {}) {
        return this._get('/balances/' + address, opts);
    }

    async getAddress(address) {
        return this._get('/address/' + address);
    }

    async getPublicKey(address) {
        return this._get('/pubkey/' + address);
    }

    async getHolders(tick, opts = {}) {
        return this._get('/holders/' + tick, opts);
    }

    async getCredits(query, type, opts = {}) {
        return this._get('/credits/' + query + '/' + type, opts);
    }

    async getDebits(query, type, opts = {}) {
        return this._get('/debits/' + query + '/' + type, opts);
    }

    async getEscrows(query, type, opts = {}) {
        return this._get('/escrows/' + query + '/' + type, opts);
    }


    /*
     *  Token Methods
     */

    async getToken(tick) {
        return this._get('/token/' + tick);
    }

    async getTokens(query, type, opts = {}) {
        return this._get('/tokens/' + query + '/' + type, opts);
    }

    async getIssues(query, type, opts = {}) {
        return this._get('/issues/' + query + '/' + type, opts);
    }


    /*
     *  Transaction & History Methods
     */

    async getTransaction(query, type) {
        return this._get('/transaction/' + query + '/' + type);
    }

    async getAction(actionIndex) {
        return this._get('/action/' + actionIndex);
    }

    async getActions(params = {}) {
        return this._get('/actions', params);
    }

    async getBlock(blockIndex) {
        return this._get('/block/' + blockIndex);
    }

    async getHistory(query, type, opts = {}) {
        return this._get('/history/' + query + '/' + type, opts);
    }


    /*
     *  ACTION-Specific Query Methods
     */

    async getAddresses(query, type, opts = {}) {
        return this._get('/addresses/' + query + '/' + type, opts);
    }

    async getAirdrops(query, type, opts = {}) {
        return this._get('/airdrops/' + query + '/' + type, opts);
    }

    async getBatches(query, type, opts = {}) {
        return this._get('/batches/' + query + '/' + type, opts);
    }

    async getBroadcasts(query, type, opts = {}) {
        return this._get('/broadcasts/' + query + '/' + type, opts);
    }

    async getCallbacks(query, type, opts = {}) {
        return this._get('/callbacks/' + query + '/' + type, opts);
    }

    async getDestroys(query, type, opts = {}) {
        return this._get('/destroys/' + query + '/' + type, opts);
    }

    async getCoinpays(query, type, opts = {}) {
        return this._get('/coinpays/' + query + '/' + type, opts);
    }

    async getCoinpayExpires(query, type, opts = {}) {
        return this._get('/coinpay_expires/' + query + '/' + type, opts);
    }

    async getCoinpayObligations(query, type, opts = {}) {
        return this._get('/coinpay_obligations/' + query + '/' + type, opts);
    }

    async getDispensers(query, type, opts = {}) {
        return this._get('/dispensers/' + query + '/' + type, opts);
    }

    async getDispenses(query, type, opts = {}) {
        return this._get('/dispenses/' + query + '/' + type, opts);
    }

    // Dispenser lifecycle events — type ∈ {block, address}.
    async getDispenserCancels(query, type, opts = {}) {
        return this._get('/dispenser_cancels/' + query + '/' + type, opts);
    }

    async getDispenserCloses(query, type, opts = {}) {
        return this._get('/dispenser_closes/' + query + '/' + type, opts);
    }

    async getDispenserExpires(query, type, opts = {}) {
        return this._get('/dispenser_expires/' + query + '/' + type, opts);
    }

    async getDispenserEdits(query, type, opts = {}) {
        return this._get('/dispenser_edits/' + query + '/' + type, opts);
    }

    async getDividends(query, type, opts = {}) {
        return this._get('/dividends/' + query + '/' + type, opts);
    }

    async getFees(query, type, opts = {}) {
        return this._get('/fees/' + query + '/' + type, opts);
    }

    // Native-coin fee pre-flight for one action. Proxies to the indexer's read-only `feequote`.
    // `params` is the wire param array (without the ACTION name) or a pre-joined pipe string.
    // Returns { supported, valid, error, requiredFeeNative, requiredFeeSats, feeDestination,
    //           expectedNative, minAcceptable, maxAcceptable, oracleRound, ... }.
    async getFeeQuote({ action, params, source, feeOutputSats } = {}) {
        let q = new URLSearchParams();
        if (action !== undefined && action !== null)        q.set('action', String(action));
        if (params !== undefined && params !== null)        q.set('params', Array.isArray(params) ? params.join('|') : String(params));
        if (source !== undefined && source !== null)        q.set('source', String(source));
        if (feeOutputSats !== undefined && feeOutputSats !== null) q.set('feeOutputSats', String(feeOutputSats));
        return this._get('/feequote?' + q.toString());
    }

    // Native-coin fee schedule + current oracle prices. Proxies to the indexer's `feeschedule`.
    async getFeeSchedule() {
        return this._get('/feeschedule');
    }

    async getFiles(query, type, opts = {}) {
        return this._get('/files/' + query + '/' + type, opts);
    }

    // Fetch the raw ciphertext bytes for a token-gated FILE action by
    // ACTION_INDEX. Returns a Buffer of the encrypted file bytes
    // ([12-byte nonce][ct][16-byte GCM tag]) ready for decryption with
    // the symmetric key from the corresponding MESSAGE handoff.
    // See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
    async getGatedFileRaw(actionIndex) {
        let url = '/' + this.coin + '/api/file/' + actionIndex + '/raw';
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
            self._handleError(err, url);
        }
    }

    async getLinks(query, type, opts = {}) {
        return this._get('/links/' + query + '/' + type, opts);
    }

    async getLists(query, type, opts = {}) {
        return this._get('/lists/' + query + '/' + type, opts);
    }

    async getMessages(query, type, opts = {}) {
        return this._get('/messages/' + query + '/' + type, opts);
    }

    async getMints(query, type, opts = {}) {
        return this._get('/mints/' + query + '/' + type, opts);
    }

    async getOrders(query, type, opts = {}) {
        return this._get('/orders/' + query + '/' + type, opts);
    }

    // Order lifecycle events — type ∈ {block, address}.
    async getOrderCancels(query, type, opts = {}) {
        return this._get('/order_cancels/' + query + '/' + type, opts);
    }

    async getOrderEdits(query, type, opts = {}) {
        return this._get('/order_edits/' + query + '/' + type, opts);
    }

    async getOrderExpires(query, type, opts = {}) {
        return this._get('/order_expires/' + query + '/' + type, opts);
    }

    // Completed order matches (auto-matched counter-orders). The explorer
    // route keys matches by block, so type is 'block'.
    async getOrderMatches(query, type = 'block', opts = {}) {
        if (query)
            return this._get('/order_matches/' + query + '/' + type, opts);
        return this._get('/order_matches', opts);
    }

    async getSends(query, type, opts = {}) {
        return this._get('/sends/' + query + '/' + type, opts);
    }

    async getSleeps(query, type, opts = {}) {
        return this._get('/sleeps/' + query + '/' + type, opts);
    }

    async getSwaps(query, type, opts = {}) {
        return this._get('/swaps/' + query + '/' + type, opts);
    }

    // Swap lifecycle events — type ∈ {block, address}.
    async getSwapCancels(query, type, opts = {}) {
        return this._get('/swap_cancels/' + query + '/' + type, opts);
    }

    async getSwapEdits(query, type, opts = {}) {
        return this._get('/swap_edits/' + query + '/' + type, opts);
    }

    async getSwapExpires(query, type, opts = {}) {
        return this._get('/swap_expires/' + query + '/' + type, opts);
    }

    // Completed swap matches (two auto-matched counter-swaps). The explorer
    // route keys matches by block, so type is 'block'.
    async getSwapMatches(query, type = 'block', opts = {}) {
        if (query)
            return this._get('/swap_matches/' + query + '/' + type, opts);
        return this._get('/swap_matches', opts);
    }

    async getSweeps(query, type, opts = {}) {
        return this._get('/sweeps/' + query + '/' + type, opts);
    }


    /*
     *  Price Methods
     */

    // PRICE v0 validator COIN/FIAT snapshots + v1 user TOKEN/FIAT oracle —
    // type ∈ {block, address, source, token}.
    async getPrices(query, type, opts = {}) {
        if (query)
            return this._get('/prices/' + query + '/' + type, opts);
        return this._get('/prices', opts);
    }

    // Oracle price-snapshot rounds — type ∈ {pair, round, status}.
    async getPriceSnapshots(query, type, opts = {}) {
        if (query)
            return this._get('/price_snapshots/' + query + '/' + type, opts);
        return this._get('/price_snapshots', opts);
    }


    /*
     *  Contract / VM Methods
     */

    async getContract(contractActionIndex) {
        return this._get('/contract/' + contractActionIndex);
    }

    async getContracts(query, type, opts = {}) {
        if (query)
            return this._get('/contracts/' + query + '/' + type, opts);
        return this._get('/contracts', opts);
    }

    async getContractState(contractActionIndex, key) {
        if (key)
            return this._get('/contract/' + contractActionIndex + '/state/' + key);
        return this._get('/contract/' + contractActionIndex + '/state');
    }

    async getContractBalance(contractActionIndex, tick) {
        if (tick)
            return this._get('/contract/' + contractActionIndex + '/balance/' + tick);
        return this._get('/contract/' + contractActionIndex + '/balance');
    }

    async getExecution(executionActionIndex) {
        return this._get('/execution/' + executionActionIndex);
    }

    async getExecutions(contractActionIndex, opts = {}) {
        if (contractActionIndex)
            return this._get('/executions/' + contractActionIndex, opts);
        return this._get('/executions', opts);
    }

    async getDeposits(query, type, opts = {}) {
        return this._get('/deposits/' + query + '/' + type, opts);
    }

    async getWithdrawals(query, type, opts = {}) {
        return this._get('/withdrawals/' + query + '/' + type, opts);
    }


    /*
     *  Staking Methods
     */

    async getStakes(query, type, opts = {}) {
        if (query)
            return this._get('/stakes/' + query + '/' + type, opts);
        return this._get('/stakes', opts);
    }

    async getDelegations(query, type, opts = {}) {
        return this._get('/delegations/' + query + '/' + type, opts);
    }

    async getValidators(opts = {}) {
        return this._get('/validators', opts);
    }

    async getValidatorRewards(query, type, opts = {}) {
        return this._get('/rewards/' + query + '/' + type, opts);
    }

    // Contract-targeted stakes (STAKE v3) — type ∈ {address, block, contract}.
    async getContractStakes(query, type, opts = {}) {
        if (query)
            return this._get('/contract_stakes/' + query + '/' + type, opts);
        return this._get('/contract_stakes', opts);
    }

    // Contract-targeted unstakes (UNSTAKE v1) — type ∈ {address, block, contract}.
    async getContractUnstakes(query, type, opts = {}) {
        if (query)
            return this._get('/contract_unstakes/' + query + '/' + type, opts);
        return this._get('/contract_unstakes', opts);
    }

    // External Attestation Framework rows (ATTEST v0 requests + v1/v2
    // responses from the `attests` table) — type ∈ {address, block, contract}.
    async getAttestations(query, type, opts = {}) {
        if (query)
            return this._get('/attestations/' + query + '/' + type, opts);
        return this._get('/attestations', opts);
    }

    // Slash events emitted by contracts via xchain.contract.slash —
    // type ∈ {address, block, contract}.
    async getSlashEvents(query, type, opts = {}) {
        if (query)
            return this._get('/slash_events/' + query + '/' + type, opts);
        return this._get('/slash_events', opts);
    }


    /*
     *  Market Methods
     */

    async getMarkets(tick) {
        if (tick)
            return this._get('/markets/' + tick);
        return this._get('/markets');
    }

    async getMarket(tick1, tick2) {
        return this._get('/market/' + tick1 + '/' + tick2);
    }

    async getMarketHistory(tick1, tick2, address, opts = {}) {
        if (address)
            return this._get('/market/' + tick1 + '/' + tick2 + '/history/' + address, opts);
        return this._get('/market/' + tick1 + '/' + tick2 + '/history', opts);
    }

    async getMarketOrders(tick1, tick2, address, opts = {}) {
        if (address)
            return this._get('/market/' + tick1 + '/' + tick2 + '/orders/' + address, opts);
        return this._get('/market/' + tick1 + '/' + tick2 + '/orders', opts);
    }

    async getOrderbook(tick1, tick2) {
        return this._get('/market/' + tick1 + '/' + tick2 + '/orderbook');
    }


    /*
     *  Utility Methods
     */

    // Indexer status. Returns per-coin maps:
    //   supported / available — configured and currently-served coins
    //   last_block[coin]       — highest block the indexer has processed
    //   last_block_time[coin]  — block_time of that block
    //   decoder_tip[coin]      — the decoder's highest *processed* block, or null
    //                            if unavailable. NOT the coin node's chain tip — see
    //                            the decoder's health() RPC for the chain->decoder gap.
    //   decoder_lag_blocks[coin] — decoder_tip - last_block (>= 0), or null when
    //                            decoder_tip is null. Lets a caller detect a stalled
    //                            indexer (indexer->decoder slice) from this single
    //                            call rather than a separate tip query.
    async getStatus() {
        return this._get('/status');
    }

    // Unconfirmed mempool actions — type ∈ {address, token}.
    async getMempool(query, type, opts = {}) {
        return this._get('/mempool/' + query + '/' + type, opts);
    }

    // Network-wide summary (chain heights, indexer status, peer counts). Also
    // includes a `finality` map ({ BTC, LTC, DOGE }) — the recommended number of
    // confirmations to wait before treating a same-chain receipt as final
    // (display/UX guidance; the indexer itself processes actions at the tip).
    async getNetwork(opts = {}) {
        return this._get('/network', opts);
    }

    async search(query, type) {
        // Search uses the /explorer/ path instead of /api/
        let url = '/' + this.coin + '/explorer/search/' + query + '/' + type;
        let self = this;

        let retryConfig = this.retry === false ? { maxRetries: 0 } : this.retry;

        try {
            return await withRetry(async () => {
                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'explorer', method: 'GET', url });
                try {
                    let response = await self.client.get(url);
                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'explorer', method: 'GET', url, status: response.status });
                    return response.data;
                } catch (err) {
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'explorer', method: 'GET', url, error: err.message });
                    if (isRetryable(err)) throw err;
                    self._handleError(err, url);
                }
            }, retryConfig, null);
        } catch (err) {
            if (err instanceof SDKExplorerError) throw err;
            self._handleError(err, url);
        }
    }

}

module.exports = ExplorerClient;
