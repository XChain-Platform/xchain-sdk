/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain SDK - Explorer Client
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
            baseURL: 'http://' + this.baseUrl + ':' + this.port,
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
        if (opts.page !== undefined)      params.page = opts.page;
        if (opts.limit !== undefined)     params.limit = opts.limit;
        if (opts.sortorder !== undefined) params.sortorder = opts.sortorder;
        if (opts.start !== undefined)     params.start = opts.start;
        if (opts.length !== undefined)    params.length = opts.length;
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

    async getDispensers(query, type, opts = {}) {
        return this._get('/dispensers/' + query + '/' + type, opts);
    }

    async getDispenses(query, type, opts = {}) {
        return this._get('/dispenses/' + query + '/' + type, opts);
    }

    async getDividends(query, type, opts = {}) {
        return this._get('/dividends/' + query + '/' + type, opts);
    }

    async getFees(query, type, opts = {}) {
        return this._get('/fees/' + query + '/' + type, opts);
    }

    async getFiles(query, type, opts = {}) {
        return this._get('/files/' + query + '/' + type, opts);
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

    async getSends(query, type, opts = {}) {
        return this._get('/sends/' + query + '/' + type, opts);
    }

    async getSleeps(query, type, opts = {}) {
        return this._get('/sleeps/' + query + '/' + type, opts);
    }

    async getSwaps(query, type, opts = {}) {
        return this._get('/swaps/' + query + '/' + type, opts);
    }

    async getSweeps(query, type, opts = {}) {
        return this._get('/sweeps/' + query + '/' + type, opts);
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

    async getStatus() {
        return this._get('/status');
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
