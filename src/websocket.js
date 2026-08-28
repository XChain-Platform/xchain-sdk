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

const wsModule = require('ws');
const { SDKExplorerError } = require('./errors.js');

// Resolve the constructor across module-interop shapes. In Node, require('ws')
// IS the class. In a browser bundle the `ws` specifier is aliased to an ESM
// shim (xchain-wallet packages/core/src/shims/ws-browser.js), and the bundler
// hands CommonJS consumers an interop wrapper around that ESM namespace rather
// than the class itself, so prefer an explicit named/default export when the
// module object is not directly constructible.
const WebSocket = typeof wsModule === 'function'
    ? wsModule
    : ((wsModule && typeof wsModule.WebSocket === 'function' && wsModule.WebSocket)
        || (wsModule && typeof wsModule.default === 'function' && wsModule.default)
        || wsModule);

// readyState values, spelled out rather than read off the module.
//
// NEVER compare against WebSocket.OPEN here. Rollup/Vite wrap the ESM
// browser shim with getAugmentedNamespace(), which copies only the namespace
// KEYS (`default`, `WebSocket`) onto a constructible function. Static class
// properties such as OPEN and CONNECTING are not namespace keys, so they are
// dropped: in the wallet bundle `WebSocket.OPEN` evaluated to undefined, every
// `readyState === WebSocket.OPEN` guard was permanently false, and _send()
// silently dropped every frame on an open, healthy socket. Result: no
// subscription was ever confirmed and every wallet notification channel was
// dead, with a 10s "No response for request id" warning as the only symptom.
// The readyState values are fixed by the WebSocket spec and by Node's `ws`, so
// a literal is both correct and immune to how the module gets bundled.
const WS_CONNECTING = 0;
const WS_OPEN       = 1;

// WS event-envelope schema version this SDK build understands. The explorer
// stamps every frame with `schema_version` (see xchain-explorer/src/ws/schema-version.js)
// so consumers can gate their parsing instead of silently mis-parsing a
// reshaped payload; keep this in sync with the explorer's WS_SCHEMA_VERSION.
const WS_SCHEMA_VERSION = 2;

// Network string -> explorer coin code, generated from the canonical coin
// registry (same convention as explorer.js): a display prefix ('' mainnet,
// 'T' testnet, 'R' regtest) prepended to the ticker (e.g. dogecoin-testnet -> TDOGE).
const coins = require('./coins');
const NET_DISPLAY_PREFIX = { mainnet: '', testnet: 'T', regtest: 'R' };
const COIN_PREFIX_MAP = {};
for(const _tick of coins.ALLOWED_COINS)
    for(const _network of coins.NETWORKS)
        COIN_PREFIX_MAP[coins.COIN_FULL_NAME[_tick] + '-' + _network] = NET_DISPLAY_PREFIX[_network] + _tick;


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

        // Tolerate baseUrl already being a full http(s) URL (e.g. derived from
        // explorerUrl when websocketUrl wasn't set). In that case strip any
        // trailing slash and swap http→ws / https→wss for the WebSocket scheme.
        let url;
        if (this.baseUrl.startsWith('http://') || this.baseUrl.startsWith('https://')) {
            let wsBase = this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
            url = wsBase + '/' + this.coin + '/api/websocket';
        } else {
            url = this.protocol + '://' + this.baseUrl + ':' + this.port + '/' + this.coin + '/api/websocket';
        }

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
                this._schemaWarned = false;
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

    // Bookkeeping key for one tracked subscription: the channel array and the
    // params, compared exactly as unsubscribe() has always compared them (the
    // JSON of the channels, and the JSON of `params || {}`). Keying on those same
    // two strings is deliberate: unsubscribeBetFeed documents that its params
    // object must be built IDENTICALLY to subscribeBetFeed's or the tracked entry
    // is never released, and that property has to survive refcounting. A looser
    // key (channel-only, or entity-only) would let one caller's teardown release
    // a subscription that was opened with a different server-side filter.
    _subscriptionKey(channels, params) {
        // One JSON array rather than two strings joined by a separator: a
        // separator has to be a character neither side can contain, and the
        // obvious pick (a NUL) makes this file BINARY to grep and ripgrep, which
        // silently drops it out of every source-wide search. Encoding the pair
        // is unambiguous and keeps the file text.
        return JSON.stringify([channels, params || {}]);
    }

    // Returns a Promise resolved by the SUBSCRIBED confirmation.
    //
    // REFCOUNTED: N subscribes to the same (channels, params) produce ONE tracked
    // replay entry and ONE server subscribe, and only the last unsubscribe talks
    // to the server.
    //
    // Before this, every call pushed an unconditional entry and unsubscribe()
    // filtered out EVERY matching one, so two independent subscriptions to a
    // single address channel (onAddress plus onMempoolAction, or two wallet
    // features watching one address) had two failure modes at once. They
    // double-replayed that channel on every reconnect, and they MUTUALLY
    // DESTROYED each other: the first teardown sent the server unsubscribe that
    // ended the OTHER subscription's live delivery, with nothing in either
    // caller's code to hint at it and no error anywhere. Capacity is the third
    // reason: the explorer caps subscriptions per CONNECTION
    // (WS_MAX_SUBSCRIPTIONS, 25 by default) and a wallet opens one connection per
    // chain, so subscribing twice per address halves how many addresses it can
    // watch. Do not "simplify" this back into an unconditional push.
    //
    // Known bound, unchanged by refcounting: sharing is per (channels, params),
    // not per entity. Two subscribes to one address with DIFFERENT params (a
    // `types`-filtered onAddress alongside a bare one) stay separate entries
    // here, which mirrors the server rather than diverging from it: there the
    // address channel is keyed by entity, the second subscribe overwrites the
    // first one's filter, and either teardown ends the single shared server-side
    // subscription.
    subscribe(channels, params) {
        const key      = this._subscriptionKey(channels, params);
        const existing = this._subscriptions.find(sub => sub.key === key);
        if (existing) {
            existing.refs += 1;
            // Callers await this. The server answers one SUBSCRIBED per subscribe
            // frame and we are deliberately not sending a second frame, so hand
            // back the first call's confirmation: an already-live subscription
            // resolves immediately, one still in flight resolves with the same
            // frame both callers are waiting on, and one the server never
            // confirmed rejects for this caller too, which is the truth about the
            // subscription it just joined. Waiting on a SUBSCRIBED that will
            // never be sent would hang the caller for the full request timeout.
            return existing.pending || Promise.resolve(null);
        }

        const id  = 'sub-' + (this.nextId++);
        const msg = { action: 'subscribe', id, channels };
        if (params) msg.params = params;

        const pending = this._sendWithResponse(id, msg);

        // Track for reconnect replay. `params` is stored by reference, as it
        // always was, so _resubscribe and the key see the same object.
        this._subscriptions.push({ key, channels, params: params || {}, refs: 1, pending });

        return pending;
    }

    // Subscribe to one betting market's live events: bet placed, deadline latch
    // (market closed), resolved, cancelled, expired. A market page uses this to
    // keep pool totals and implied odds current, which matters because a
    // parimutuel payout is only ever a projection until the market resolves.
    // Returns the same SUBSCRIBED promise as subscribe(), so reconnect replay
    // covers it automatically.
    // The channel NAME is bare and the market id rides in `params.action_index`.
    // Sending a composite 'bet_feed:<index>' is what this helper used to do, and the
    // server rejects it outright with `Unknown channel`: it validates the name
    // against a fixed set before ever looking at the entity key
    // (explorer ChannelManager: entity channels "require params"). Verified live
    // 2026-07-26 against the running explorer, where the composite form failed
    // every subscribe, so the whole channel was unreachable from the SDK.
    subscribeBetFeed(feedActionIndex, params) {
        const index = String(feedActionIndex == null ? '' : feedActionIndex).trim();
        if (!/^\d+$/.test(index))
            throw new Error('subscribeBetFeed: feedActionIndex must be a numeric ACTION_INDEX, got ' + JSON.stringify(feedActionIndex));
        return this.subscribe(['bet_feed'], Object.assign({}, params, { action_index: index }));
    }

    // Stop following a betting market. Mirrors subscribeBetFeed's channel name
    // exactly so the tracked-subscription filter in unsubscribe() matches.
    unsubscribeBetFeed(feedActionIndex, params) {
        const index = String(feedActionIndex == null ? '' : feedActionIndex).trim();
        if (!/^\d+$/.test(index))
            throw new Error('unsubscribeBetFeed: feedActionIndex must be a numeric ACTION_INDEX, got ' + JSON.stringify(feedActionIndex));
        // Same shape as subscribeBetFeed, and it MUST stay identical: the
        // tracked-subscription filter in unsubscribe() matches on the channel array
        // and the params, so a mismatch here would leave the entry in
        // `_subscriptions` and silently re-subscribe on the next reconnect.
        return this.unsubscribe(['bet_feed'], Object.assign({}, params, { action_index: index }));
    }

    // Refcounted counterpart of subscribe(): each call releases ONE holder, and
    // only the last one drops the replay entry and tells the server. An
    // unsubscribe for a (channels, params) this client is not tracking still
    // sends the frame, exactly as before, so a caller can cancel a subscription
    // it did not open through subscribe().
    unsubscribe(channels, params) {
        const key   = this._subscriptionKey(channels, params);
        const index = this._subscriptions.findIndex(sub => sub.key === key);
        if (index !== -1) {
            const entry = this._subscriptions[index];
            entry.refs -= 1;
            // Another holder is still listening on this exact subscription. The
            // server-side subscription is shared, so sending the unsubscribe here
            // would silently end THEIR delivery: send nothing and keep the replay
            // entry. This early return is the whole fix; deleting it restores the
            // mutual-destruction bug described on subscribe().
            if (entry.refs > 0) return;
            this._subscriptions.splice(index, 1);
        }

        const msg = { action: 'unsubscribe', channels };
        if (params) msg.params = params;

        this._send(msg);
    }

    // Returns a Promise resolved by SUBSCRIPTION_LIST response
    listSubscriptions() {
        const id = 'list-' + (this.nextId++);
        return this._sendWithResponse(id, { action: 'list_subscriptions', id });
    }

    on(eventType, callback) {
        if (!this._handlers[eventType]) this._handlers[eventType] = [];
        this._handlers[eventType].push(callback);
    }

    off(eventType, callback) {
        if (!this._handlers[eventType]) return;
        this._handlers[eventType] = this._handlers[eventType].filter(cb => cb !== callback);
    }

    once(eventType, callback) {
        const wrapper = (msg) => {
            this.off(eventType, wrapper);
            callback(msg);
        };
        this.on(eventType, wrapper);
    }


    // Internal methods

    _onMessage(msg) {
        // Envelope schema gate: the server stamps every frame with schema_version.
        // If it speaks a NEWER envelope schema than this SDK build understands,
        // payload shapes may have changed; warn once per connection instead of
        // silently mis-parsing (mirrors the explorer's own bundled browser client,
        // src/content/js/xchain-ws.js). Do not fail closed: parsing continues.
        if (msg.schema_version !== undefined && msg.schema_version > WS_SCHEMA_VERSION && !this._schemaWarned) {
            this._schemaWarned = true;
            const mismatch = { serverSchemaVersion: msg.schema_version, clientSchemaVersion: WS_SCHEMA_VERSION };
            if (this.hooks.onWsSchemaMismatch) {
                try { this.hooks.onWsSchemaMismatch(mismatch); } catch (e) {}
            }
            if (this._handlers['schema_mismatch']) {
                for (const cb of this._handlers['schema_mismatch']) {
                    try { cb(mismatch); } catch (e) {}
                }
            }
        }

        // Track action indexes for catch-up. WELCOME's latest_action_index rides the
        // same path, so a fresh client seeds from WELCOME here rather than in a second
        // branch below that could drift from this one.
        if (msg.data) {
            this._advanceCursor(msg.data.action_index);
            this._advanceCursor(msg.data.latest_action_index);
        }

        // Handle system messages
        if (msg.type === 'WELCOME') {
            this.serverInfo = msg.data;
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
        if (this.ws && this.ws.readyState === WS_OPEN) {
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
                // connect() failed; will trigger another _reconnect via close handler
            }
        }, delay);
    }

    // Advance the catch-up cursor to `raw` when it is higher, comparing as BigInt so
    // two consecutive indices above 2^53 stay distinct. Stores the wire's own decimal
    // string: nothing here converts to Number, and nothing serializes a BigInt (which
    // JSON.stringify throws on). A value that is not a non-negative integer literal is
    // not a cursor and is ignored, which also absorbs null/undefined.
    _advanceCursor(raw) {
        if (raw === null || raw === undefined) return;
        const val = String(raw);
        if (!/^[0-9]+$/.test(val)) return;
        if (this.lastActionIndex === null || BigInt(val) > BigInt(this.lastActionIndex))
            this.lastActionIndex = val;
    }

    _resubscribe() {
        for (const sub of this._subscriptions) {
            const params = Object.assign({}, sub.params);
            // Same gate as before the cursor became a string: a chain still at index 0
            // gets no since_action_index, so an unseeded reconnect cannot ask the server
            // to replay from the genesis of the feed.
            if (this.lastActionIndex !== null && BigInt(this.lastActionIndex) > 0n) {
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

// Public surface: consumers compare/display the schema version this build
// understands (e.g. against the server's `schema_version` frame stamp).
WebSocketClient.WS_SCHEMA_VERSION = WS_SCHEMA_VERSION;

module.exports = WebSocketClient;
