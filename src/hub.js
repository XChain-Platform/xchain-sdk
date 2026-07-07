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
// reconstructs exactly the tree a full fetch would have produced.
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
            let hubPort = options.hubPort || 8001;
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

        // Polling
        this.pollInterval = options.hubPollInterval || 60000; // 60 seconds
        this._pollTimer   = null;
    }

    // Fetch all configs from the hub via JSON-RPC (tries each endpoint in order)
    async getAllConfig() {
        let payload = {
            jsonrpc: '2.0',
            method:  'getallconfigs',
            // Echo the high-water mark so the hub returns only rows changed since
            // our last poll; 0 requests the full tree (initial fetch / old hub).
            params:  { since_updated_at: this.lastWatermark },
            id:      1
        };

        let lastError = null;
        let headers = {};
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            try {
                let response = await axios.post(url, payload, { timeout: this.timeout, headers });
                if (response.data && response.data.result) {
                    this._lastGoodIdx = idx;
                    this.configs = this._applyConfigResult(response.data.result);
                    this.lastFetch = Date.now();
                    return this.configs;
                }
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
                let response = await axios.post(url, payload, { timeout: this.timeout });
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
                let response = await axios.post(url, payload, { timeout: this.timeout });
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
