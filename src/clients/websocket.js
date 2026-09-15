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
 * XChain Platform SDK - WebSocket Client
 *
 * Real-time event client wrapping the xchain-explorer WebSocket API.
 * Mirrors the ExplorerClient pattern: connection management,
 * subscription API, event dispatch, reconnection with catch-up.
 *
 ********************************************************************/

const { WebSocket, WS_CONNECTING, WS_OPEN, WS_SCHEMA_VERSION } = require('./websocket/socket_constants.js');
const { SDKExplorerError } = require('../utils/errors.js');
const { installMethods } = require('../utils/install_methods.js');

function websocketUrl(client) {
    // Tolerate baseUrl already being a full http(s) URL (e.g. derived from
    // explorerUrl when websocketUrl wasn't set). In that case strip any
    // trailing slash and swap http→ws / https→wss for the WebSocket scheme.
    if (client.baseUrl.startsWith('http://') || client.baseUrl.startsWith('https://')) {
        let wsBase = client.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
        return wsBase + '/' + client.coin + '/api/websocket';
    }
    return client.protocol + '://' + client.baseUrl + ':' + client.port + '/' + client.coin + '/api/websocket';
}

function attachSocketListeners(client, url, resolve, reject) {
    // Resolve on WELCOME, reject on error before WELCOME
    let welcomed = false;

    client.ws.on('open', () => {
        client.connected = true;
        client.reconnectAttempts = 0;
        client._schemaWarned = false;
        client._startPing();
        if (client.hooks.onWsConnect) {
            try { client.hooks.onWsConnect({ url }); } catch (e) {}
        }
    });

    client.ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            return;
        }

        client._onMessage(msg);

        if (!welcomed && msg.type === 'WELCOME') {
            welcomed = true;
            resolve(client.serverInfo);
        }
    });

    client.ws.on('close', (code) => {
        client.connected = false;
        client._stopPing();

        if (client.hooks.onWsDisconnect) {
            try { client.hooks.onWsDisconnect({ code }); } catch (e) {}
        }

        if (!welcomed) {
            reject(new SDKExplorerError('WS_CONNECTION_CLOSED', 'WebSocket closed before WELCOME (code: ' + code + ')', { code }));
            return;
        }

        if (!client.intentionalClose) {
            client._reconnect();
        }
    });

    client.ws.on('error', (err) => {
        if (!welcomed) {
            reject(new SDKExplorerError('WS_CONNECTION_FAILED', 'WebSocket error: ' + err.message, { error: err.message }));
        }
    });
}

function openWebSocket(client, url) {
    return new Promise((resolve, reject) => {
        try {
            client.ws = new WebSocket(url);
        } catch (e) {
            reject(new SDKExplorerError('WS_CONNECTION_FAILED', 'WebSocket connection failed: ' + e.message, { url }));
            return;
        }
        attachSocketListeners(client, url, resolve, reject);
    });
}


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
        this._schemaWarned      = false;
        // The catch-up cursor is the exact decimal STRING the v2 wire carries, or null
        // when unseeded. Number() rounded it above 2^53 and the rounded value went back
        // out as since_action_index, so a reconnect asked for rows after an action that
        // had never been delivered. null rather than 0 so an unseeded cursor
        // is distinguishable from a chain sitting at index "0".
        this.lastActionIndex    = null;
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

        // Lazy-readiness hook (awaited once before connecting so the SDK can
        // overlay hub-discovered endpoints). No-op when not supplied.
        this._readyHook         = options.readyHook || null;
    }

    // Returns a Promise that resolves when the WELCOME message is received
    async connect() {
        if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) {
            return this.serverInfo;
        }

        // Await lazy readiness (hub-discovery overlay) before deriving the URL,
        // so a hub-refined explorer host is reflected here on first connect.
        if (this._readyHook) await this._readyHook();

        this.intentionalClose = false;
        const url = websocketUrl(this);
        return openWebSocket(this, url);
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

    // Repoint at a new host/port (used by hub-discovery overlay). The URL is
    // re-derived on the next connect(); if currently connected, reconnect so
    // the new endpoint takes effect.
    setBase(url, port) {
        if (!url && !port) return;
        let newUrl  = url  || this.baseUrl;
        let newPort = port || this.port;
        if (newUrl === this.baseUrl && newPort === this.port) return;
        this.baseUrl = newUrl;
        this.port    = newPort;
        if (this.isConnected()) {
            this.disconnect();
            this.connect().catch(() => {});
        }
    }

    isConnected() {
        return this.connected && this.ws && this.ws.readyState === WS_OPEN;
    }
}

installMethods(WebSocketClient.prototype, require('./websocket/subscriptions.js'), require('./websocket/message_pump.js'));

// Public surface: consumers compare/display the schema version this build
// understands (e.g. against the server's `schema_version` frame stamp).
WebSocketClient.WS_SCHEMA_VERSION = WS_SCHEMA_VERSION;

module.exports = WebSocketClient;
