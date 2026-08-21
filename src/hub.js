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
 * XChain Platform SDK - Hub Connector
 *
 * Connects to xchain-hub for service discovery and config resolution
 *
 ********************************************************************/

const axios = require('axios');
const { SDKHubError } = require('./errors.js');

// Fold a getallconfigs delta (only the rows that changed since our cursor) into
// the cached nested config map, mutating and returning `base`. The hub's configs
// table is upsert-only (rows are never deleted), so applying successive deltas
// reconstructs the tree a full fetch would have produced -- PROVIDED no row is
// skipped by the cursor. The hub's cursor is inclusive (`>=` on whole-second
// time, item #2265) so the boundary second is re-delivered, and getAllConfig
// still re-requests one second behind the watermark to stay loss-free against
// an older hub that compared `>` (see the cursor comment there). This merge is
// idempotent, which is what makes either overlap safe.
function mergeConfigDelta(base, delta){
    for(let coin in delta){
        if(!base[coin]) base[coin] = {};
        for(let network in delta[coin]){
            if(!base[coin][network]) base[coin][network] = {};
            for(let module in delta[coin][network]){
                if(!base[coin][network][module]) base[coin][network][module] = {};
                let params = delta[coin][network][module];
                for(let param in params){
                    base[coin][network][module][param] = params[param];
                }
            }
        }
    }
    return base;
}

// The hub reports a config-DB read failure as an HTTP-200 JSON-RPC result of
// the shape { error: "..." } with no configs member (xchain-hub api.js
// getallconfigs); a legitimate config tree can never match this shape.
function isHubErrorEnvelope(result){
    return !!(result && typeof result === 'object' && result.error && !result.configs);
}

// Read { seq, watermark } off a newer hub's { configs, seq, watermark } envelope.
// watermark is null when the envelope is the bare map or carries no watermark
// (both are the full tree); seq is 0 when absent.
function hubEnvelopeMarks(result){
    let wrapped = result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result);
    if(!wrapped) return { seq: 0, watermark: null };
    let watermark = ('watermark' in result && result.watermark !== null && result.watermark !== undefined)
        ? (Number(result.watermark) || 0) : null;
    return { seq: Number(result.seq) || 0, watermark };
}

// Per-request axios options carrying the injected agents. The hub
// has several URLs and they can differ in scheme, so the choice is made per
// URL rather than once per client.
function agentOptsFor(url, pool){
    if(!pool) return { proxy: false };
    let isHttps = String(url).startsWith('https');
    let agent = isHttps ? pool.httpsAgent : pool.httpAgent;
    if(!agent) return { proxy: false };
    return isHttps ? { proxy: false, httpsAgent: agent } : { proxy: false, httpAgent: agent };
}

// Network string → hub config keys mapping
const NETWORK_MAP = {
    'bitcoin-mainnet':   { coin: 'bitcoin',  network: 'mainnet' },
    'bitcoin-testnet':   { coin: 'bitcoin',  network: 'testnet' },
    'bitcoin-regtest':   { coin: 'bitcoin',  network: 'regtest' },
    'litecoin-mainnet':  { coin: 'litecoin', network: 'mainnet' },
    'litecoin-testnet':  { coin: 'litecoin', network: 'testnet' },
    'litecoin-regtest':  { coin: 'litecoin', network: 'regtest' },
    'dogecoin-mainnet':  { coin: 'dogecoin', network: 'mainnet' },
    'dogecoin-testnet':  { coin: 'dogecoin', network: 'testnet' },
    'dogecoin-regtest':  { coin: 'dogecoin', network: 'regtest' }
};


class HubConnector {

    constructor(options = {}) {
        this.timeout = options.timeout || 5000;

        // The hub client posts through bare `axios.post`, with no
        // pooled client of its own, so it needs the injected agents handed to
        // it explicitly. Missing this would have left hub traffic going direct
        // while explorer and encoder traffic was proxied, which is the worst
        // of both: the toggle looks like it works and one lane still leaks.
        this._pool = options.pool || {};

        // Optional hub API key: getallconfigs is in the hub's sensitive-read
        // tier (its response carries service DB credentials) and 401s without
        // a key once the hub operator sets HUB_API_KEY. Public zero-config
        // SDK users don't hold a key and should not call getallconfigs against
        // a keyed hub; operators/mesh services pass options.hubApiKey (or set
        // HUB_API_KEY in a Node environment). Guarded for browser bundles
        // where process is undefined.
        this.apiKey = options.hubApiKey ||
            (typeof process !== 'undefined' && process.env && process.env.HUB_API_KEY) || '';

        // Multi-endpoint support: hubValidators takes priority over hubUrl:hubPort
        if(options.hubValidators && Array.isArray(options.hubValidators) && options.hubValidators.length > 0){
            this.urls = options.hubValidators.map(e => e.startsWith('http') ? e : 'http://' + e);
        } else {
            let hubUrl  = options.hubUrl || 'localhost';
            let hubPort = options.hubPort || 10000;
            this.urls = [hubUrl.startsWith('http') ? hubUrl : 'http://' + hubUrl + ':' + hubPort];
        }

        // Backward compat: this.url points to the first endpoint
        this.url = this.urls[0];

        // Sticky-last-good endpoint: start each call at the last endpoint that
        // answered, so a degraded first endpoint isn't retried first every call
        // (which would cost the full timeout per call before falling back).
        this._lastGoodIdx = 0;

        // Parsed config cache
        this.configs    = null;
        this.lastFetch  = null;
        // Last committed hub config sequence (from getallconfigs { configs, seq });
        // 0 against an older hub that returns the bare map.
        this.lastSeq    = 0;
        // Config high-water mark (epoch seconds) echoed from getallconfigs; sent
        // back as `since_updated_at` so the hub returns only rows changed since
        // the previous poll. 0 (initial, and after any restart) requests the full
        // tree; also stays 0 against an older hub that doesn't report a watermark.
        this.lastWatermark = 0;
        // Endpoint index the cursor was obtained from. A wall-clock since_updated_at
        // cursor is only valid against the hub that produced it (each hub stamps
        // updated_at = NOW() at its own apply time), so a poll answered by any other
        // endpoint asks for the full tree and replaces the cache instead of merging.
        this._watermarkEndpointIdx = null;

        // Polling
        this.pollInterval = options.hubPollInterval || 60000; // 60 seconds
        this._pollTimer   = null;
    }

    // Fetch all configs from the hub via JSON-RPC (tries each endpoint in order)
    async getAllConfig() {
        let lastError = null;
        let headers = {};
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            // The cursor is only valid against the endpoint that produced it (see
            // _watermarkEndpointIdx): any other candidate is asked for the full tree.
            let cursorValid = this.lastWatermark > 0 && this._watermarkEndpointIdx === idx;
            // Re-request the boundary second (cursor - 1), not the watermark itself. The
            // hub's cursor compares UNIX_TIMESTAMP(updated_at) >= ? in WHOLE seconds
            // (inclusive since item #2265), and its watermark is MAX(updated_at) in whole
            // seconds, so a row upserted in the watermark's second W after the hub read
            // MAX(updated_at) = W is re-delivered on the next poll. An older hub compared
            // `> W` and would strand that row forever (the SDK would serve the stale value
            // until restart), so keep the one-second overlap as deployment-skew protection;
            // do not "simplify" the - 1 away. mergeConfigDelta is an idempotent upsert
            // (the configs table is never deleted from), so re-merging a row we already
            // have is a no-op; the cost is one second of rows per poll.
            let sinceCursor = cursorValid ? Math.max(0, this.lastWatermark - 1) : 0;
            try {
                let result = await this._postGetAllConfigs(url, sinceCursor, headers);
                if (result === undefined) continue;
                // The hub returns its FAILURE payload through the same JSON-RPC
                // `result` member ({ error: "..." }, no configs), with no
                // JSON-RPC error member and a 2xx status, so it is indistinguishable
                // from success at the HTTP layer. Treat it as a failed endpoint:
                // record it and continue the failover loop, rather than caching the
                // error object AS the config tree (which then strands
                // extractServiceEndpoints with an empty map and no diagnostic).
                if (isHubErrorEnvelope(result)) {
                    lastError = new Error('hub returned error result: ' + result.error);
                    continue;
                }
                if (!cursorValid) {
                    // Full tree from an endpoint other than the cursor's origin (failover,
                    // or the first fetch): replace the cache, never merge across hubs.
                    this.lastWatermark = 0;
                    this.configs       = null;
                } else if (this._hubConfigRegressed(result)) {
                    // Hub restart / restore from an older snapshot: the served watermark or
                    // seq is BELOW what this endpoint gave us before. The delta we asked for
                    // (cursor from the lost window) cannot carry rows the restored hub now
                    // holds at an OLDER updated_at, and mergeConfigDelta only upserts, so a
                    // merge would serve lost-window values forever with a fresh lastFetch.
                    // Mirror the indexer's HUB CONFIG REGRESSION handling: alarm (a hub that
                    // lost config state is an operator event), drop the cache, reset the
                    // cursor, and re-fetch the full tree from the same endpoint once.
                    let served = hubEnvelopeMarks(result);
                    console.error('XChain SDK HubConnector: HUB CONFIG REGRESSION: ' + url + ' served seq ' +
                                  served.seq + '/watermark ' + served.watermark + ', below last-seen ' +
                                  this.lastSeq + '/' + this.lastWatermark +
                                  ' (hub restart or restore from an older snapshot); discarding cached config and re-fetching the full tree.');
                    this.lastWatermark = 0;
                    this.configs       = null;
                    result = await this._postGetAllConfigs(url, 0, headers);
                    if (result === undefined) continue;
                    if (isHubErrorEnvelope(result)) {
                        lastError = new Error('hub returned error result: ' + result.error);
                        continue;
                    }
                }
                this._lastGoodIdx = idx;
                this.configs = this._applyConfigResult(result);
                // Bind the (possibly advanced) cursor to the endpoint that answered.
                this._watermarkEndpointIdx = idx;
                this.lastFetch = Date.now();
                return this.configs;
            } catch (err) {
                lastError = err;
            }
        }

        throw new SDKHubError(
            'HUB_UNAVAILABLE',
            'Failed to fetch config from hub (tried ' + this.urls.length + ' endpoint(s)): ' + (lastError ? lastError.message : 'no result'),
            { urls: this.urls, error: lastError ? lastError.message : 'no result' }
        );
    }

    // POST one getallconfigs call with the given cursor and return the JSON-RPC
    // result member (undefined when the response carries none; throws on transport
    // failure so the failover loop records it).
    async _postGetAllConfigs(url, sinceCursor, headers) {
        let payload = {
            jsonrpc: '2.0',
            method:  'getallconfigs',
            // Echo the high-water mark so the hub returns only rows changed since
            // our last poll; 0 requests the full tree (initial fetch / old hub).
            params:  { since_updated_at: sinceCursor },
            id:      1
        };
        let response = await axios.post(url, payload, { timeout: this.timeout, headers, ...agentOptsFor(url, this._pool) });
        if (response.data && response.data.result) return response.data.result;
        return undefined;
    }

    // True when a watermarked envelope from the cursor's own endpoint reports a
    // seq or watermark BELOW the last one it served us (hub restart / restore
    // from an older snapshot). A missing watermark is the full tree (handled by
    // _applyConfigResult) and a zero watermark means an empty configs table, so
    // neither counts; the next poll re-fetches in full either way.
    _hubConfigRegressed(result) {
        let marks = hubEnvelopeMarks(result);
        if (marks.watermark === null) return false;
        return (marks.watermark > 0 && marks.watermark < this.lastWatermark) ||
               (this.lastSeq > 0 && marks.seq < this.lastSeq);
    }

    // Fold a getallconfigs result into this.configs and return the full nested
    // map. Newer hubs wrap the payload as { configs, seq, watermark }: when a
    // watermark is present the payload is a delta (only rows changed since the
    // cursor we sent), so we MERGE it into the cache and advance the cursor.
    // Older hubs return the bare map (or a { configs, seq } wrapper without a
    // watermark): those are always the full tree, so we REPLACE. Callers
    // (extractServiceEndpoints) see the same full-map shape regardless of hub
    // version. seq stays 0 against an old hub.
    _applyConfigResult(result) {
        let payload, seq, watermark;
        if (result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)) {
            payload   = result.configs;
            seq       = Number(result.seq) || 0;
            watermark = ('watermark' in result) ? result.watermark : undefined;
        } else {
            payload   = result;
            seq       = 0;
            watermark = undefined;
        }
        this.lastSeq = seq;

        if (watermark === undefined || watermark === null) {
            // Hub doesn't report a watermark. Payload is the full tree. Reset the
            // cursor so the next poll also requests in full.
            this.lastWatermark = 0;
            return payload || {};
        }

        let sentCursor = this.lastWatermark > 0;
        this.lastWatermark = Number(watermark) || 0;

        if (sentCursor && this.configs) {
            // Delta against the cursor we sent: merge changed rows into the cache.
            return mergeConfigDelta(this.configs, payload || {});
        }
        // First fetch (or post-restart): payload is the full tree.
        return payload || {};
    }

    // Ping the hub (tries each endpoint in order)
    async ping() {
        let payload = {
            jsonrpc: '2.0',
            method:  'ping',
            id:      1
        };

        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            try {
                let response = await axios.post(url, payload, { timeout: this.timeout, ...agentOptsFor(url, this._pool) });
                if(response.data && response.data.result){
                    this._lastGoodIdx = idx;
                    return true;
                }
            } catch (err) {
                // Try next endpoint
            }
        }
        return false;
    }

    // Fetch per-capability MIN_STAKE thresholds from the hub (tries each
    // endpoint in order). Returns the array of { capability, min_stake,
    // disabled } rows, or null when no endpoint answered. Capabilities are
    // global governance config, so this is not chain-scoped.
    async getCapabilityThresholds() {
        let payload = {
            jsonrpc: '2.0',
            method:  'getcapabilitythresholds',
            id:      1
        };

        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            try {
                let response = await axios.post(url, payload, { timeout: this.timeout, ...agentOptsFor(url, this._pool) });
                let result = response.data && response.data.result;
                if(result && Array.isArray(result.thresholds)){
                    this._lastGoodIdx = idx;
                    return result.thresholds;
                }
            } catch (err) {
                // Try next endpoint
            }
        }
        return null;
    }

    // Extract service endpoints for a given network from the hub config
    // Returns { encoderUrl, encoderPort, explorerUrl, explorerPort } or null fields
    extractServiceEndpoints(network) {
        if (!this.configs || !network) return {};

        let netMap = NETWORK_MAP[network];
        if (!netMap) return {};

        let coinConfig = this.configs[netMap.coin];
        if (!coinConfig) return {};

        let networkConfig = coinConfig[netMap.network];
        if (!networkConfig) return {};

        let endpoints = {};

        // Extract encoder endpoint
        let encoderConfig = networkConfig['xchain-encoder'];
        if (encoderConfig) {
            if (encoderConfig.host)         endpoints.encoderUrl  = encoderConfig.host;
            if (encoderConfig.port)         endpoints.encoderPort = parseInt(encoderConfig.port);
            if (encoderConfig.service_port) endpoints.encoderPort = parseInt(encoderConfig.service_port);
        }

        // Extract explorer endpoint (explorer is typically shared across networks)
        // Check network-specific first, then fall back to top-level
        let explorerConfig = networkConfig['xchain-explorer'];
        if (!explorerConfig) {
            // Explorer may be registered as a shared service under any coin/network
            for (let coin in this.configs) {
                for (let net in this.configs[coin]) {
                    if (this.configs[coin][net]['xchain-explorer']) {
                        explorerConfig = this.configs[coin][net]['xchain-explorer'];
                        break;
                    }
                }
                if (explorerConfig) break;
            }
        }
        if (explorerConfig) {
            if (explorerConfig.host)         endpoints.explorerUrl  = explorerConfig.host;
            if (explorerConfig.port)         endpoints.explorerPort = parseInt(explorerConfig.port);
            if (explorerConfig.service_port) endpoints.explorerPort = parseInt(explorerConfig.service_port);
        }

        return endpoints;
    }

    // Start polling for config updates
    startPolling(callback) {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(async () => {
            try {
                await this.getAllConfig();
                if (callback) callback(this.configs);
            } catch (err) {
                // Silently continue: hub unavailability during polling is non-fatal
                console.warn('Hub poll failed:', err);
            }
        }, this.pollInterval);
        // Don't prevent process exit
        if (this._pollTimer.unref) this._pollTimer.unref();
    }

    // Stop polling
    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

}

module.exports = HubConnector;
