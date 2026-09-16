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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const config = require('../config.js');
const ExplorerClient = require('../clients/explorer.js');
const EncoderClient = require('../clients/encoder.js');
const WebSocketClient = require('../clients/websocket.js');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk');
const { publicDefaults } = require('../utils/endpoints.js');
const { SDKConfigError } = require('../utils/errors.js');

// Build the encoder client synchronously so URL resolution and assignment stay adjacent.
function initializeEncoderClient(sdk, resolved, hooks, retry, pool, readyHook, pub) {
    let encoderUrl  = resolved.encoderUrl  || config.env.encoderUrl() || pub.encoderUrl;
    let encoderPort = resolved.encoderPort || config.env.encoderPort();
    if (encoderUrl || encoderPort) {
        sdk.encoder = new EncoderClient({
            encoderUrl:  encoderUrl,
            encoderPort: encoderPort ? parseInt(encoderPort) : undefined,
            // Explicit because this client's options are cherry-picked, not
            // spread the way HubConnector's are; without the line an
            // encoderApiKey passed to the SDK reaches no encoder request.
            encoderApiKey: resolved.encoderApiKey || sdk.options.encoderApiKey,
            timeout:     resolved.timeout,
            hooks:       hooks,
            retry:       retry,
            pool:        pool,
            readyHook:   readyHook
        });
    }
}

// Keep client setup and lifecycle behavior together so construction stays readable.
module.exports = {

    // Config resolution: constructor options > env vars > public defaults > localhost.
    initClients(resolved) {
        let network = resolved.network || config.env.network();
        let hooks   = this.options.hooks || {};
        let retry   = this.options.retry !== undefined ? this.options.retry : {};
        let pool    = this.options.pool || {};
        // Empty for regtest, so those clients keep their localhost fallback.
        let pub       = publicDefaults(network);
        let readyHook = () => this.ensureReady();

        let explorerUrl  = resolved.explorerUrl  || config.env.explorerUrl() || pub.explorerUrl;
        let explorerPort = resolved.explorerPort || config.env.explorerPort();
        if (network && (explorerUrl || explorerPort)) {
            this.explorer = new ExplorerClient({
                network:      network,
                explorerUrl:  explorerUrl,
                explorerPort: explorerPort ? parseInt(explorerPort) : undefined,
                timeout:      resolved.timeout,
                hooks:        hooks,
                retry:        retry,
                pool:         pool,
                readyHook:    readyHook
            });
        } else if (network) {
            this.explorer = new ExplorerClient({ network, timeout: resolved.timeout, hooks, retry, pool, readyHook });
        }

        initializeEncoderClient(this, resolved, hooks, retry, pool, readyHook, pub);

        // WebSocket follows explorer URL/port unless an explicit websocketUrl is given.
        let websocketUrl  = resolved.websocketUrl  || this.options.websocketUrl  || config.env.websocketUrl();
        let websocketPort = resolved.websocketPort || this.options.websocketPort || config.env.websocketPort();
        if (network && (websocketUrl || websocketPort || explorerUrl || explorerPort)) {
            let wsUrl  = websocketUrl  || explorerUrl;
            let wsPort = websocketPort ? parseInt(websocketPort) : (explorerPort ? parseInt(explorerPort) : undefined);
            if (!this.ws || this.ws.baseUrl !== wsUrl || this.ws.port !== wsPort) {
                if (this.ws) this.ws.disconnect();
                this.ws = new WebSocketClient({
                    network:       network,
                    websocketUrl:  wsUrl,
                    websocketPort: wsPort,
                    hooks:         hooks,
                    retry:         retry,
                    readyHook:     readyHook
                });
            }
        }
    },

    // Async initialization: fetch config from hub and resolve service endpoints.
    // Optional: service clients are already usable after construction (explicit
    // URLs, env vars, or public defaults). Call this to force hub discovery up
    // front; otherwise it happens lazily on the first service call (ensureReady).
    // Unlike the lazy path, init() surfaces a hub error when there is no fallback
    // explorer/encoder client to fall back to. Safe to call multiple times.
    async init() {
        if (!this.hub) return;
        // Satisfy the lazy gate with the same in-flight discovery.
        if (!this._readyPromise) this._readyPromise = this.discover().catch(() => {});
        try {
            await this.discover();
        } catch (err) {
            // Non-fatal when we already have usable clients (explicit/default).
            if (this.explorer && this.encoder) {
                log.warn('Hub unavailable, using explicit/default config:', err.message || err);
                return;
            }
            throw err;
        }
    },

    // Lazy-readiness gate. Awaited once (via each client's readyHook) before the
    // first request, so hub-discovered endpoints overlay the default clients.
    // Never throws: on hub failure the hardcoded/explicit config stands.
    ensureReady() {
        if (!this.hub) return Promise.resolve();
        if (!this._readyPromise) this._readyPromise = this.discover().catch(() => {});
        return this._readyPromise;
    },

    // One-shot hub discovery + endpoint overlay (+ start polling). Guarded so
    // init() and the lazy gate share a single in-flight fetch. May throw (init()
    // inspects the error; ensureReady() swallows it).
    discover() {
        if (this._discovering) return this._discovering;
        this._discovering = (async () => {
            await this.hub.getAllConfig();
            this.applyEndpoints();
            this.startPollingOnce();
        })();
        return this._discovering;
    },

    // Overlay hub-discovered endpoints onto the live clients (mutating, not
    // rebuilding, so in-flight callers see the new target). Skips any endpoint
    // the caller pinned via constructor options. Creates a client if one does
    // not yet exist (e.g. hub-only configuration).
    applyEndpoints() {
        if (!this.hub) return;
        let network   = this.options.network || config.env.network();
        let endpoints = this.hub.extractServiceEndpoints(network);
        let hooks     = this.options.hooks || {};
        let retry     = this.options.retry !== undefined ? this.options.retry : {};
        let pool      = this.options.pool || {};
        let readyHook = () => this.ensureReady();

        // Explorer
        if (!this.options.explorerUrl && endpoints.explorerUrl) {
            if (this.explorer) {
                if (!this.isDowngrade('explorer', this.explorer, endpoints.explorerUrl))
                    this.explorer.setBase(endpoints.explorerUrl, endpoints.explorerPort);
            } else if (network) {
                this.explorer = new ExplorerClient({ network, explorerUrl: endpoints.explorerUrl, explorerPort: endpoints.explorerPort, timeout: this.options.timeout, hooks, retry, pool, readyHook });
            }
        }

        // Encoder
        if (!this.options.encoderUrl && endpoints.encoderUrl) {
            if (this.encoder) {
                if (!this.isDowngrade('encoder', this.encoder, endpoints.encoderUrl))
                    this.encoder.setBase(endpoints.encoderUrl, endpoints.encoderPort);
            } else {
                this.encoder = new EncoderClient({ encoderUrl: endpoints.encoderUrl, encoderPort: endpoints.encoderPort, encoderApiKey: this.options.encoderApiKey, timeout: this.options.timeout, hooks, retry, pool, readyHook });
            }
        }

        // WebSocket follows the explorer endpoint unless a websocket/explorer URL was pinned
        if (!this.options.websocketUrl && !this.options.explorerUrl && endpoints.explorerUrl) {
            if (this.ws) {
                if (!this.isDowngrade('websocket', this.ws, endpoints.explorerUrl))
                    this.ws.setBase(endpoints.explorerUrl, endpoints.explorerPort);
            } else if (network) {
                this.ws = new WebSocketClient({ network, websocketUrl: endpoints.explorerUrl, websocketPort: endpoints.explorerPort, hooks, retry, readyHook });
            }
        }
    },

    // Guard against hub discovery downgrading a secure default. Hub service
    // config commonly stores a bare internal host + port; overlaying that onto
    // a client whose current base is https (the public default) would replace
    // https://explorer.xchain.io with a broken http://host:port. When the
    // current base is secure and the incoming endpoint is not, keep the secure
    // base and warn once. (No effect on http/localhost bases; dev is unchanged.
    // Set option `allowInsecureEndpoints: true` to opt out.)
    isDowngrade(service, client, incomingUrl) {
        if (this.options.allowInsecureEndpoints) return false;
        let currentSecure  = String(client.baseUrl || '').startsWith('https://');
        let incomingSecure = String(incomingUrl || '').startsWith('https://');
        if (currentSecure && !incomingSecure) {
            if (!this._downgradeWarned) this._downgradeWarned = {};
            if (!this._downgradeWarned[service]) {
                this._downgradeWarned[service] = true;
                log.warn('Ignoring hub ' + service + ' endpoint (' + incomingUrl + '): would downgrade the https default to an insecure transport. Publish a full https:// URL in the hub config, or set allowInsecureEndpoints:true.');
            }
            return true;
        }
        return false;
    },

    // Start hub config polling exactly once; re-applies endpoints on each update.
    startPollingOnce() {
        if (this._polling) return;
        this._polling = true;
        this.hub.startPolling(() => this.applyEndpoints());
    },

    async start() {
        log.log('Starting up ' + this.name + ' v' + this.version + '...');
        if (this.hub) await this.init();

        while (true) {
            if (this.stopFlag) break;
            await this.util.sleep(this.config['STOP_CHECK_INTERVAL']);
        }
    },

    stop() {
        this.stopFlag = true;
        if (this.hub) this.hub.stopPolling();
        if (this.ws) this.ws.disconnect();
    },

    requireExplorer() {
        // Refuse to go further without an explorer: every read of chain state goes through it.
        if (!this.explorer)
            throw new SDKConfigError('EXPLORER_NOT_CONFIGURED', 'Explorer not configured. Provide network + explorerUrl, or use hub discovery via init().');
        return this.explorer;
    },

    requireEncoder() {
        // Refuse to go further without an encoder: it is what turns an action into a transaction.
        if (!this.encoder)
            throw new SDKConfigError('ENCODER_NOT_CONFIGURED', 'Encoder not configured. Provide encoderUrl, or use hub discovery via init().');
        return this.encoder;
    },
};
