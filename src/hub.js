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
 * XChain Platform SDK - Hub Connector
 *
 * Connects to xchain-hub for service discovery and config resolution
 *
 ********************************************************************/

const axios = require('axios');
const { SDKHubError } = require('./errors.js');

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

        // Polling
        this.pollInterval = options.hubPollInterval || 60000; // 60 seconds
        this._pollTimer   = null;
    }

    // Fetch all configs from the hub via JSON-RPC (tries each endpoint in order)
    async getAllConfig() {
        let payload = {
            jsonrpc: '2.0',
            method:  'getallconfigs',
            params:  [],
            id:      1
        };

        let lastError = null;
        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            try {
                let response = await axios.post(url, payload, { timeout: this.timeout });
                if (response.data && response.data.result) {
                    this._lastGoodIdx = idx;
                    // Newer hubs wrap the config map as { configs, seq } so consumers
                    // can detect a config change committed between polls; older hubs
                    // return the bare nested map. Record the committed sequence on
                    // this.lastSeq and keep this.configs as the bare map so callers
                    // (extractServiceEndpoints) are unaffected by hub version. seq is
                    // 0 against an old hub.
                    let result = response.data.result;
                    if (result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)) {
                        this.configs = result.configs;
                        this.lastSeq = Number(result.seq) || 0;
                    } else {
                        this.configs = result;
                        this.lastSeq = 0;
                    }
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
                // Silently continue — hub unavailability during polling is non-fatal
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
