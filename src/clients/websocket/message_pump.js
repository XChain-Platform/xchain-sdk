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
const { coinPrefix } = require('../../utils/endpoints.js');
const { WS_OPEN, WS_SCHEMA_VERSION, COIN_PREFIX_MAP } = require('./socket_constants.js');
const catchUp = require('./catch_up.js');

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

    onMessage(msg) {
        warnOnSchemaMismatch(this, msg);

        // Track action indexes for catch-up. WELCOME seeds only an unset cursor, and a
        // reconnect replay holds it until every queued catch-up closes (catch_up.js).
        catchUp.trackCursor(this, msg);

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

        // A COMPLETE or an error carrying the pending catch-up's id moves the reconnect on.
        if (this._catchUp && (msg.type === 'CATCH_UP_COMPLETE' || msg.type === 'error')) {
            catchUp.answerCatchUp(this, msg);
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

    send(data) {
        if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    },

    sendWithResponse(id, msg, timeoutMs) {
        timeoutMs = timeoutMs || 10000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this._pending[id];
                reject(new SDKExplorerError('WS_TIMEOUT', 'No response for request id: ' + id));
            }, timeoutMs);

            this._pending[id] = { resolve, reject, timeout: timer };
            this.send(msg);
        });
    },

    rejectAllPending(reason) {
        for (const id of Object.keys(this._pending)) {
            const p = this._pending[id];
            clearTimeout(p.timeout);
            p.reject(new SDKExplorerError('WS_CONNECTION_CLOSED', reason));
            delete this._pending[id];
        }
    },

    reconnect() {
        if (this.intentionalClose) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('connection_lost', {});
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
                this.resubscribe();
            } catch (e) {
                // connect() failed; will trigger another reconnect via close handler
            }
        }, delay);
    },

    // Advance the catch-up cursor to `raw` when it is higher, comparing as BigInt so
    // two consecutive indices above 2^53 stay distinct. Stores the wire's own decimal
    // string: nothing here converts to Number, and nothing serializes a BigInt (which
    // JSON.stringify throws on). A value that is not a non-negative integer literal is
    // not a cursor and is ignored, which also absorbs null/undefined.
    advanceCursor(raw) {
        if (raw === null || raw === undefined) return;
        const val = String(raw);
        if (!/^[0-9]+$/.test(val)) return;
        if (this.lastActionIndex === null || BigInt(val) > BigInt(this.lastActionIndex))
            this.lastActionIndex = val;
    },

    // Replay every tracked subscription after a reconnect, sending the catch-ups one at a
    // time because the server refuses an overlapping one (catch_up.js).
    resubscribe() {
        catchUp.resubscribe(this);
    },

    startPing() {
        this.stopPing();
        this._pingTimer = setInterval(() => {
            this.send({ action: 'ping' });
        }, this._pingIntervalMs);
    },

    stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    },

    emit(type, data) {
        const msg = { type, timestamp: Date.now(), data };
        if (this._handlers[type]) {
            for (const cb of this._handlers[type]) {
                try { cb(msg); } catch (e) {}
            }
        }
    },

    deriveCoinPrefix(network) {
        if (!network) return 'BTC';
        // Resolve through the same strict lookup the explorer client uses, so
        // both clients accept and refuse exactly the same network strings.
        let prefix = coinPrefix(network);
        if (!prefix)
            throw new SDKExplorerError('INVALID_NETWORK', 'Unknown network: ' + network + '. Valid: ' + Object.keys(COIN_PREFIX_MAP).join(', '), { network });
        return prefix;
    }
};
