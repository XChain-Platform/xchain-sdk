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
 * XChain Platform SDK - WebSocket Client
 *
 * Real-time event client wrapping the xchain-explorer WebSocket API.
 * Mirrors the ExplorerClient pattern — connection management,
 * subscription API, event dispatch, reconnection with catch-up.
 *
 ********************************************************************/

const WebSocket = require('ws');
const { SDKExplorerError } = require('./errors.js');

// Network string → explorer coin prefix mapping (same as explorer.js)
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


class WebSocketClient {

    constructor(options = {}) {
        this.baseUrl  = options.websocketUrl  || options.explorerUrl || 'localhost';
        this.port     = options.websocketPort || options.explorerPort || 8080;
        this.protocol = options.websocketProtocol || 'ws';
        this.coin     = this._deriveCoinPrefix(options.network);
        this.hooks    = options.hooks || {};

        // Reconnection config
        let retry = options.retry || {};
        this.maxReconnectAttempts = retry.maxRetries    || 10;
        this.baseDelay           = retry.baseDelay      || 1000;
        this.maxDelay            = retry.maxDelay        || 30000;
        this.backoffFactor       = retry.backoffFactor   || 2;

        // State
        this.ws                 = null;
        this.connected          = false;
        this.intentionalClose   = false;
        this.reconnectAttempts  = 0;
        this.serverInfo         = null;
        this.lastActionIndex    = 0;
        this.catchingUp         = false;
        this.nextId             = 1;

        // Tracked subscriptions for replay on reconnect
        this._subscriptions     = [];

        // Event handlers: eventType -> [callback]
        this._handlers          = {};

        // Pending request-response correlation: id -> { resolve, reject, timeout }
        this._pending           = {};

        // Ping timer
        this._pingTimer         = null;
        this._pingIntervalMs    = options.pingInterval || 25000;
    }

    // Connect to the WebSocket server
    // Returns a Promise that resolves when the WELCOME message is received
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve(this.serverInfo);
        }

        this.intentionalClose = false;

        const url = this.protocol + '://' + this.baseUrl + ':' + this.port + '/' + this.coin + '/api/websocket';

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(url);
            } catch (e) {
                reject(new SDKExplorerError('WS_CONNECTION_FAILED', 'WebSocket connection failed: ' + e.message, { url }));
                return;
            }

            // Resolve on WELCOME, reject on error before WELCOME
            let welcomed = false;

            this.ws.on('open', () => {
                this.connected = true;
                this.reconnectAttempts = 0;
                this._startPing();
                if (this.hooks.onWsConnect) {
                    try { this.hooks.onWsConnect({ url }); } catch (e) {}
                }
            });

            this.ws.on('message', (data) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString());
                } catch (e) {
                    return;
                }

                this._onMessage(msg);

                if (!welcomed && msg.type === 'WELCOME') {
                    welcomed = true;
                    resolve(this.serverInfo);
                }
            });

            this.ws.on('close', (code) => {
                this.connected = false;
                this._stopPing();

                if (this.hooks.onWsDisconnect) {
                    try { this.hooks.onWsDisconnect({ code }); } catch (e) {}
                }

                if (!welcomed) {
                    reject(new SDKExplorerError('WS_CONNECTION_CLOSED', 'WebSocket closed before WELCOME (code: ' + code + ')', { code }));
                    return;
                }

                if (!this.intentionalClose) {
                    this._reconnect();
                }
            });

            this.ws.on('error', (err) => {
                if (!welcomed) {
                    reject(new SDKExplorerError('WS_CONNECTION_FAILED', 'WebSocket error: ' + err.message, { error: err.message }));
                }
            });
        });
    }

    // Disconnect intentionally
    disconnect() {
        this.intentionalClose = true;
        this._stopPing();
        this._rejectAllPending('Connection closed');
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    // Check if connected
    isConnected() {
        return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // Subscribe to channels with optional filters
    // Returns a Promise resolved by the SUBSCRIBED confirmation
    subscribe(channels, params) {
        const id  = 'sub-' + (this.nextId++);
        const msg = { action: 'subscribe', id, channels };
        if (params) msg.params = params;

        // Track for reconnect replay
        this._subscriptions.push({ channels, params: params || {} });

        return this._sendWithResponse(id, msg);
    }

    // Unsubscribe from channels
    unsubscribe(channels, params) {
        const msg = { action: 'unsubscribe', channels };
        if (params) msg.params = params;

        // Remove from tracked subscriptions
        this._subscriptions = this._subscriptions.filter(sub =>
            JSON.stringify(sub.channels) !== JSON.stringify(channels) ||
            JSON.stringify(sub.params) !== JSON.stringify(params || {})
        );

        this._send(msg);
    }

    // List active subscriptions
    // Returns a Promise resolved by SUBSCRIPTION_LIST response
    listSubscriptions() {
        const id = 'list-' + (this.nextId++);
        return this._sendWithResponse(id, { action: 'list_subscriptions', id });
    }

    // Register an event handler
    on(eventType, callback) {
        if (!this._handlers[eventType]) this._handlers[eventType] = [];
        this._handlers[eventType].push(callback);
    }

    // Remove an event handler
    off(eventType, callback) {
        if (!this._handlers[eventType]) return;
        this._handlers[eventType] = this._handlers[eventType].filter(cb => cb !== callback);
    }

    // Register a one-time event handler
    once(eventType, callback) {
        const wrapper = (msg) => {
            this.off(eventType, wrapper);
            callback(msg);
        };
        this.on(eventType, wrapper);
    }


    // ---- Internal methods ----

    _onMessage(msg) {
        // Track action indexes for catch-up
        if (msg.data) {
            if (msg.data.action_index) {
                const idx = Number(msg.data.action_index);
                if (idx > this.lastActionIndex) this.lastActionIndex = idx;
            }
            if (msg.data.latest_action_index) {
                const idx = Number(msg.data.latest_action_index);
                if (idx > this.lastActionIndex) this.lastActionIndex = idx;
            }
        }

        // Handle system messages
        if (msg.type === 'WELCOME') {
            this.serverInfo = msg.data;
            if (this.lastActionIndex === 0 && msg.data && msg.data.latest_action_index) {
                this.lastActionIndex = msg.data.latest_action_index;
            }
        }

        if (msg.type === 'CATCH_UP_COMPLETE') {
            this.catchingUp = false;
        }
        if (msg.catch_up && !this.catchingUp) {
            this.catchingUp = true;
        }

        // Resolve pending request-response
        if (msg.id && this._pending[msg.id]) {
            const pending = this._pending[msg.id];
            clearTimeout(pending.timeout);
            delete this._pending[msg.id];
            if (msg.type === 'error') {
                pending.reject(new SDKExplorerError(msg.data.code, msg.data.message));
            } else {
                pending.resolve(msg);
            }
        }

        // Dispatch hooks
        if (this.hooks.onWsMessage) {
            try { this.hooks.onWsMessage(msg); } catch (e) {}
        }

        // Dispatch to registered handlers
        if (msg.type && this._handlers[msg.type]) {
            const handlers = this._handlers[msg.type].slice(); // copy to avoid mutation during iteration
            for (const cb of handlers) {
                try { cb(msg); } catch (e) {}
            }
        }

        // Wildcard handlers
        if (this._handlers['*']) {
            for (const cb of this._handlers['*']) {
                try { cb(msg); } catch (e) {}
            }
        }
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _sendWithResponse(id, msg, timeoutMs) {
        timeoutMs = timeoutMs || 10000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this._pending[id];
                reject(new SDKExplorerError('WS_TIMEOUT', 'No response for request id: ' + id));
            }, timeoutMs);

            this._pending[id] = { resolve, reject, timeout: timer };
            this._send(msg);
        });
    }

    _rejectAllPending(reason) {
        for (const id of Object.keys(this._pending)) {
            const p = this._pending[id];
            clearTimeout(p.timeout);
            p.reject(new SDKExplorerError('WS_CONNECTION_CLOSED', reason));
            delete this._pending[id];
        }
    }

    _reconnect() {
        if (this.intentionalClose) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this._emit('connection_lost', {});
            return;
        }

        const attempt = this.reconnectAttempts++;
        const delay = Math.min(
            this.maxDelay,
            this.baseDelay * Math.pow(this.backoffFactor, attempt)
        ) + Math.floor(Math.random() * 1000);

        if (this.hooks.onWsReconnect) {
            try { this.hooks.onWsReconnect({ attempt: attempt + 1, delay }); } catch (e) {}
        }

        setTimeout(async () => {
            try {
                await this.connect();
                this._resubscribe();
            } catch (e) {
                // connect() failed — will trigger another _reconnect via close handler
            }
        }, delay);
    }

    _resubscribe() {
        for (const sub of this._subscriptions) {
            const params = Object.assign({}, sub.params);
            if (this.lastActionIndex > 0) {
                params.since_action_index = this.lastActionIndex;
            }
            this._send({ action: 'subscribe', channels: sub.channels, params });
        }
    }

    _startPing() {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            this._send({ action: 'ping' });
        }, this._pingIntervalMs);
    }

    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    _emit(type, data) {
        const msg = { type, timestamp: Date.now(), data };
        if (this._handlers[type]) {
            for (const cb of this._handlers[type]) {
                try { cb(msg); } catch (e) {}
            }
        }
    }

    _deriveCoinPrefix(network) {
        if (!network) return 'BTC';
        let prefix = COIN_PREFIX_MAP[network];
        if (!prefix)
            throw new SDKExplorerError('INVALID_NETWORK', 'Unknown network: ' + network + '. Valid: ' + Object.keys(COIN_PREFIX_MAP).join(', '), { network });
        return prefix;
    }
}

module.exports = WebSocketClient;
