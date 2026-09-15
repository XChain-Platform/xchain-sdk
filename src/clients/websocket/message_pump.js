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

const { SDKExplorerError } = require('../../utils/errors.js');
const { WS_OPEN, WS_SCHEMA_VERSION, COIN_PREFIX_MAP } = require('./socket_constants.js');

// Envelope schema gate: the server stamps every frame with schema_version.
// If it speaks a NEWER envelope schema than this SDK build understands,
// payload shapes may have changed; warn once per connection instead of
// silently mis-parsing (mirrors the explorer's own bundled browser client,
// src/content/js/xchain-ws.js). Do not fail closed: parsing continues.
function warnOnSchemaMismatch(client, msg) {
    if (msg.schema_version !== undefined && msg.schema_version > WS_SCHEMA_VERSION && !client._schemaWarned) {
        client._schemaWarned = true;
        const mismatch = { serverSchemaVersion: msg.schema_version, clientSchemaVersion: WS_SCHEMA_VERSION };
        if (client.hooks.onWsSchemaMismatch) {
            try { client.hooks.onWsSchemaMismatch(mismatch); } catch (e) {}
        }
        if (client._handlers['schema_mismatch']) {
            for (const cb of client._handlers['schema_mismatch']) {
                try { cb(mismatch); } catch (e) {}
            }
        }
    }
}

module.exports = {
    // Internal methods

    _onMessage(msg) {
        warnOnSchemaMismatch(this, msg);

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
    },

    _send(data) {
        if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    },

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
    },

    _rejectAllPending(reason) {
        for (const id of Object.keys(this._pending)) {
            const p = this._pending[id];
            clearTimeout(p.timeout);
            p.reject(new SDKExplorerError('WS_CONNECTION_CLOSED', reason));
            delete this._pending[id];
        }
    },

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
    },

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
    },

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
    },

    _startPing() {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            this._send({ action: 'ping' });
        }, this._pingIntervalMs);
    },

    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    },

    _emit(type, data) {
        const msg = { type, timestamp: Date.now(), data };
        if (this._handlers[type]) {
            for (const cb of this._handlers[type]) {
                try { cb(msg); } catch (e) {}
            }
        }
    },

    _deriveCoinPrefix(network) {
        if (!network) return 'BTC';
        let prefix = COIN_PREFIX_MAP[network];
        if (!prefix)
            throw new SDKExplorerError('INVALID_NETWORK', 'Unknown network: ' + network + '. Valid: ' + Object.keys(COIN_PREFIX_MAP).join(', '), { network });
        return prefix;
    }
};
