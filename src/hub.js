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
 * XChain SDK - Hub Connector
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
        this.hubUrl  = options.hubUrl || 'localhost';
        this.hubPort = options.hubPort || 8001;
        this.timeout = options.timeout || 5000;
        this.url     = 'http://' + this.hubUrl + ':' + this.hubPort;

        // Parsed config cache
        this.configs    = null;
        this.lastFetch  = null;

        // Polling
        this.pollInterval = options.hubPollInterval || 60000; // 60 seconds
        this._pollTimer   = null;
    }

    // Fetch all configs from the hub via JSON-RPC
    async getAllConfig() {
        let payload = {
            jsonrpc: '2.0',
            method:  'getallconfigs',
            params:  [],
            id:      1
        };

        try {
            let response = await axios.post(this.url, payload, { timeout: this.timeout });
            if (response.data && response.data.result) {
                this.configs   = response.data.result;
                this.lastFetch = Date.now();
                return this.configs;
            }
            return null;
        } catch (err) {
            throw new SDKHubError(
                'HUB_UNAVAILABLE',
                'Failed to fetch config from hub at ' + this.url + ': ' + err.message,
                { url: this.url, error: err.message }
            );
        }
    }

    // Ping the hub
    async ping() {
        let payload = {
            jsonrpc: '2.0',
            method:  'ping',
            id:      1
        };

        try {
            let response = await axios.post(this.url, payload, { timeout: this.timeout });
            return !!(response.data && response.data.result);
        } catch (err) {
            return false;
        }
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
                console.warn('Hub poll failed:', err.message);
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
