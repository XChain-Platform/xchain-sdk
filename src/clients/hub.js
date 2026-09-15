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
const Config = require('../config.js');
const { agentOptsFor, NETWORK_MAP } = require('./hub/config_envelope.js');


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
            Config.env.hubApiKey() || '';

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

Object.assign(HubConnector.prototype, require('./hub/config_sync.js'));

module.exports = HubConnector;
