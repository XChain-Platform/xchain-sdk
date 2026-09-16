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

const axios = require('axios');
const { SDKExplorerError, SDKRateLimitedError } = require('../../utils/errors.js');
const { withRetry, isRetryable, getRetryAfterSeconds } = require('../../utils/retry.js');
const { coinPrefix } = require('../../utils/endpoints.js');
const { getSupportedNetworks } = require('../../protocol/networks.js');

// (Coin prefix mapping lives in endpoints.coinPrefix, single source of truth,
//  shared with the public-default resolution.)

module.exports = {
    // (Re)build the axios client + keep-alive agent for the current target.
    // Picks an https agent for https bases (axios ignores httpAgent on https),
    // so connection pooling applies to public hosts too.
    buildClient() {
        let pool   = this._pool;
        let baseURL = this.baseUrl.startsWith('http') ? this.baseUrl : 'http://' + this.baseUrl + ':' + this.port;
        let isHttps = baseURL.startsWith('https');
        // An injected agent wins. The desktop wallet routes its traffic
        // through a SOCKS5 proxy when the user turns on Tor routing, and
        // that is expressed as pre-built agents because a SOCKS tunnel is a
        // different way of opening the socket, not a pool tuning knob.
        // http and https are separate because axios needs the matching one.
        // Everything else keeps the pooled default, unchanged.
        let Agent  = isHttps ? require('https').Agent : require('http').Agent;
        this._agent = (isHttps ? pool.httpsAgent : pool.httpAgent) || new Agent({
            keepAlive:      pool.keepAlive !== undefined ? pool.keepAlive : true,
            keepAliveMsecs: pool.keepAliveMsecs || 1000,
            maxSockets:     pool.maxSockets || 10,
            maxFreeSockets: pool.maxFreeSockets || 5
        });
        this.client = axios.create({
            baseURL: baseURL,
            proxy: false,
            timeout: this.timeout,
            headers: { 'Content-Type': 'application/json' },
            httpAgent:  isHttps ? undefined : this._agent,
            httpsAgent: isHttps ? this._agent : undefined
        });
    },

    // Repoint this client at a new host/port (used by hub-discovery overlay).
    // No-ops if nothing changed so in-flight callers keep a stable client.
    setBase(url, port) {
        if (!url && !port) return;
        let newUrl  = url  || this.baseUrl;
        let newPort = port || this.port;
        if (newUrl === this.baseUrl && newPort === this.port) return;
        this.baseUrl = newUrl;
        this.port    = newPort;
        this.buildClient();
    },

    deriveCoinPrefix(network) {
        if (!network) return 'BTC';
        let prefix = coinPrefix(network);
        if (!prefix)
            throw new SDKExplorerError('INVALID_NETWORK', 'Unknown network: ' + network + '. Valid: ' + getSupportedNetworks().join(', '), { network });
        return prefix;
    },

    buildParams(opts = {}) {
        let params = {};
        if (opts.page !== undefined)        params.page = opts.page;
        if (opts.limit !== undefined)       params.limit = opts.limit;
        if (opts.sortorder !== undefined)   params.sortorder = opts.sortorder;
        if (opts.start !== undefined)       params.start = opts.start;
        if (opts.length !== undefined)      params.length = opts.length;
        if (opts.tick !== undefined)        params.tick = opts.tick;
        if (opts.txid !== undefined)        params.txid = opts.txid;
        if (opts.blockIndex !== undefined)  params.blockIndex = opts.blockIndex;
        // SPV proof / checkpoint-range selectors (proof/balance + proof/validator-set
        // take ?height=, checkpoints/range takes ?from=&to=).
        if (opts.from !== undefined)        params.from = opts.from;
        if (opts.to !== undefined)          params.to = opts.to;
        if (opts.height !== undefined)      params.height = opts.height;
        return params;
    },

    async get(path, opts = {}) {
        if (this._readyHook) await this._readyHook();
        let url = '/' + this.coin + '/api' + path;
        let self = this;

        let onRetry = this.hooks.onRetry ? (attempt, delay, err) => {
            // `status` lets a hook tell a rate limit from a 5xx without parsing
            // the message; null for a transport error that never got a response.
            this.hooks.onRetry({ service: 'explorer', method: 'GET', url, attempt, delay, error: err.message, status: err.response ? err.response.status : null });
        } : null;

        // Disable retry if retry === false, or per-call via opts.noRetry (used by
        // best-effort callers like ticker compaction that must fail fast and fall
        // back rather than block on backoff). noRetry is not a query param, so
        // buildParams (whitelist) ignores it.
        let retryConfig = (this.retry === false || (opts && opts.noRetry)) ? { maxRetries: 0 } : this.retry;

        try {
            return await withRetry(async () => {
                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'explorer', method: 'GET', url });
                try {
                    let response = await self.client.get(url, { params: self.buildParams(opts) });
                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'explorer', method: 'GET', url, status: response.status });
                    self.recordFreshness(response);
                    return response.data;
                } catch (err) {
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'explorer', method: 'GET', url, error: err.message });
                    // Re-throw raw error so withRetry can inspect retryability; wrap only when not retryable
                    if (isRetryable(err)) throw err;
                    self.handleError(err, url);
                }
            }, retryConfig, onRetry);
        } catch (err) {
            // After all retries, wrap any raw (non-SDK) error into a typed SDKExplorerError
            if (err instanceof SDKExplorerError) throw err;
            self.handleError(err, url);
        }
    },

    // POST twin of get, for the batch reads: the same ready hook, retry
    // policy, hooks, freshness record and error typing, so a caller cannot tell
    // the two transports apart by how a failure arrives. Retrying is safe here
    // because the only bodies the SDK posts to the explorer are reads.
    async post(path, body, opts = {}) {
        if (this._readyHook) await this._readyHook();
        let url = '/' + this.coin + '/api' + path;
        let self = this;

        let onRetry = this.hooks.onRetry ? (attempt, delay, err) => {
            // `status` lets a hook tell a rate limit from a 5xx without parsing
            // the message; null for a transport error that never got a response.
            this.hooks.onRetry({ service: 'explorer', method: 'POST', url, attempt, delay, error: err.message, status: err.response ? err.response.status : null });
        } : null;

        // Same escape hatches as get: retry === false on the client, or
        // opts.noRetry per call. noRetry is not a query param, so buildParams
        // (whitelist) ignores it.
        let retryConfig = (this.retry === false || (opts && opts.noRetry)) ? { maxRetries: 0 } : this.retry;

        try {
            return await withRetry(async () => {
                if (self.hooks.onRequest)
                    self.hooks.onRequest({ service: 'explorer', method: 'POST', url });
                try {
                    let response = await self.client.post(url, body, { params: self.buildParams(opts) });
                    if (self.hooks.onResponse)
                        self.hooks.onResponse({ service: 'explorer', method: 'POST', url, status: response.status });
                    self.recordFreshness(response);
                    return response.data;
                } catch (err) {
                    if (self.hooks.onError)
                        self.hooks.onError({ service: 'explorer', method: 'POST', url, error: err.message });
                    // Re-throw raw error so withRetry can inspect retryability; wrap only when not retryable
                    if (isRetryable(err)) throw err;
                    self.handleError(err, url);
                }
            }, retryConfig, onRetry);
        } catch (err) {
            // After all retries, wrap any raw (non-SDK) error into a typed SDKExplorerError
            if (err instanceof SDKExplorerError) throw err;
            self.handleError(err, url);
        }
    },

    // Freshness of the explorer's indexed tip, as the explorer stamps it on
    // every data response: the XChain-Freshness / XChain-Tip-Block /
    // XChain-Tip-Age-S headers on all of them, plus a `freshness` body object
    // while the tip is stale. The explorer serves a stale coin rather than
    // refusing it, so this is how a consumer learns that what it just read is a
    // true record up to a tip that is behind. A response with no marker (an
    // older explorer) leaves the record untouched.
    recordFreshness(response) {
        let headers = (response && response.headers) || {};
        let marker  = headers['xchain-freshness'];
        let body    = response && response.data;
        let inBody  = (body && typeof body === 'object' && !Array.isArray(body) && body.freshness && typeof body.freshness === 'object') ? body.freshness : null;
        if (marker === undefined && !inBody) return;
        let stale = inBody ? inBody.stale === true : String(marker).toLowerCase() === 'stale';
        let num   = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
        this._freshness = {
            stale,
            tipBlock:      inBody && inBody.tip_block !== undefined ? num(inBody.tip_block) : num(headers['xchain-tip-block']),
            tipAgeSeconds: inBody && inBody.tip_age_seconds !== undefined ? num(inBody.tip_age_seconds) : num(headers['xchain-tip-age-s']),
            replicaHalted: inBody && typeof inBody.replica_halted === 'boolean' ? inBody.replica_halted : null,
            observedAt:    Date.now()
        };
    },

    // The last freshness marker this client saw, or null before any marked
    // response has arrived. { stale, tipBlock, tipAgeSeconds, replicaHalted,
    // observedAt }. Read this after a balance or history call to tell
    // served-and-current from served-and-behind; sdk.freshness() is the same
    // record, and sdk.assertFresh() turns a stale one into a typed error for
    // the paths that must not build on it.
    freshness() {
        return this._freshness ? Object.assign({}, this._freshness) : null;
    },

    handleError(err, url) {
        if (err.response) {
            // A 429 reaching here already survived retry.js's honoured wait, so
            // it is the caller's to handle. Keep the "Explorer returned HTTP
            // 429 for <url>" prefix byte-exact: integrators (and the wallet's
            // message-regex fallback) match on it.
            if (err.response.status === 429) {
                let seconds = getRetryAfterSeconds(err);
                throw new SDKRateLimitedError(
                    'Explorer returned HTTP 429 for ' + url + (seconds === null ? '' : '; retry after ' + seconds + ' seconds'),
                    { service: 'explorer', status: 429, retryAfterSeconds: seconds, url, data: err.response.data }
                );
            }
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
    },
};
