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

const { SDKConfigError } = require('../utils/errors.js');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk');
const { ADDRESS_EVENT_TYPES, MEMPOOL_EVENT_TYPES, oneShotTeardown, frameIsForAddress, frameIdMatches, entityGuarded } = require('./event_frames.js');

// Keep entity subscriptions together because they share frame identity guards.
module.exports = {


    /*
     *  WebSocket: Real-Time Event Methods
     */

    // Ensure WebSocket client is initialized
    _requireWs() {
        // Live updates need a WebSocket connection; without one configured, refuse.
        if (!this.ws)
            throw new SDKConfigError('WEBSOCKET_NOT_CONFIGURED', 'WebSocket not configured. Provide network + websocketUrl or explorerUrl, or use hub discovery via init().');
        return this.ws;
    },

    // Connect the WebSocket client (auto-called by init() if configured)
    async connectWs() {
        return this._requireWs().connect();
    },

    // Disconnect the WebSocket client
    disconnectWs() {
        if (this.ws) this.ws.disconnect();
    },

    // Fire-and-forget subscribe for the onX() helpers below.
    //
    // Those helpers are synchronous: they return an unsubscribe function, not a
    // promise, so NOTHING is awaiting the SUBSCRIBED confirmation. But
    // ws.subscribe() returns a promise that rejects with WS_TIMEOUT ten seconds
    // later if the explorer never confirms (it is down, returning 503, or the
    // socket dropped mid-handshake). With no consumer attached, that rejection
    // is unhandled -- and an unhandled rejection terminates the host process on
    // Node, which is how a transient explorer outage could take down a wallet's
    // Electron main process or kill a test run outright.
    //
    // The caller genuinely cannot act on this: it holds an unsubscribe fn, not a
    // promise. Losing the subscription is also self-healing, because the WS
    // client replays its tracked subscriptions on reconnect (_resubscribe). So
    // warn and carry on. Callers who DO want to await confirmation still can:
    // ws.subscribe() keeps rejecting for them.
    _subscribeDetached(ws, channels, params) {
        try {
            const pending = ws.subscribe(channels, params);
            if (pending && typeof pending.catch === 'function') {
                pending.catch((err) => {
                    log.warn(
                        'Subscription to [' + channels.join(', ') + '] was not confirmed: '
                        + (err && err.message ? err.message : err)
                        + ' (it will be replayed on reconnect)',
                    );
                });
            }
        } catch (err) {
            log.warn(
                'Subscription to [' + channels.join(', ') + '] failed: '
                + (err && err.message ? err.message : err),
            );
        }
    },

    // Listen for new blocks
    // Returns an unsubscribe function
    onBlock(callback) {
        const ws = this._requireWs();
        ws.on('NEW_BLOCK', callback);
        this._subscribeDetached(ws, ['blocks']);
        return oneShotTeardown(() => {
            ws.off('NEW_BLOCK', callback);
            ws.unsubscribe(['blocks']);
        });
    },

    // Listen for new actions with optional type/status filters
    // Returns an unsubscribe function
    onAction(callback, opts) {
        const ws = this._requireWs();
        ws.on('NEW_ACTION', callback);
        let params = {};
        if (opts && opts.types)    params.types    = opts.types;
        // `statuses` is deliberately NOT forwarded. No explorer channel
        // populates a per-event status: db.getActionsSince selects `NULL as status`,
        // and every outbound frame (NEW_ACTION, lifecycle events incl. ORDER_MATCH,
        // catch-up replay) derives its status from that row. Broadcaster._passesFilter
        // only rejects when status is truthy, so the filter could never reject anything.
        // The server matches this: it omits `statuses` from WELCOME features and from
        // the SUBSCRIBED active_filters. Forwarding it let a caller rely on a silent
        // no-op and believe it was receiving a filtered stream.
        // `ticks` is deliberately NOT forwarded either. No action frame carries a
        // tick field: db.getActionsSince selects no tick/give_tick/get_tick column, so
        // Broadcaster._passesFilter's `if (tick && ...)` never fires on the actions
        // channel, the only one a ticks filter can attach to. Forwarding it let a caller
        // believe in a stream that never narrows; the server now reports it under
        // `ignored_filters`.
        const subParams = Object.keys(params).length > 0 ? params : undefined;
        this._subscribeDetached(ws, ['actions'], subParams);
        return oneShotTeardown(() => {
            ws.off('NEW_ACTION', callback);
            ws.unsubscribe(['actions'], subParams);
        });
    },

    // Listen for events on a specific address
    // Returns an unsubscribe function
    onAddress(address, callback, opts) {
        const ws = this._requireWs();
        // Register handlers for every type the explorer routes here (see
        // ADDRESS_EVENT_TYPES); `opts.types` stays the caller's own narrowing
        // filter, applied server-side.
        const types = ADDRESS_EVENT_TYPES;
        const onEvent = entityGuarded((msg) => frameIsForAddress(msg, address), callback);
        for (const t of types) ws.on(t, onEvent);

        let params = { address };
        if (opts && opts.types)    params.types    = opts.types;
        if (opts && opts.snapshot) params.snapshot  = true;

        // The explorer sends the requested initial-state frame as a
        // top-level 'SNAPSHOT' type (not one of the `types` above), so it
        // needs its own filtered handler or the frame is silently dropped.
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'address' && msg.data.address === address){
                callback(msg);
            }
        };
        if (opts && opts.snapshot) ws.on('SNAPSHOT', onSnapshot);

        this._subscribeDetached(ws, ['address'], params);

        return oneShotTeardown(() => {
            for (const t of types) ws.off(t, onEvent);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['address'], params);
        });
    },

    // Listen for the UNCONFIRMED (pre-validation) transactions involving an
    // address: MEMPOOL_ACTION when the decoder first sees one, MEMPOOL_REMOVED
    // when it leaves the mempool. Returns an unsubscribe function.
    //
    // Frames are PRE-VALIDATION. The indexer can still reject the action at
    // confirmation, and MEMPOOL_REMOVED cannot distinguish "confirmed" from
    // "evicted", so a consumer reconciles against the confirmed NEW_ACTION feed
    // rather than treating a removal as a result.
    //
    // Frame data:
    //   MEMPOOL_ACTION  { tx_hash, source, action, data, first_seen, destinations[] }
    //   MEMPOOL_REMOVED { tx_hash, source, destinations[] }
    // `first_seen` is unix SECONDS and may be null. `destinations` is present on
    // address-channel frames only; the global `mempool` channel omits it.
    //
    // This SHARES onAddress's subscription rather than opening a second one. Both
    // subscribe ['address'] with the same `{ address }` params, so the refcount in
    // WebSocketClient.subscribe makes them one server subscription and one
    // reconnect-replay entry, and neither one's teardown ends the other's
    // delivery. That is not just tidiness: the explorer's per-connection
    // subscription cap (25 by default) is spent per subscribe, and a wallet opens
    // one connection per chain, so a second subscription per address would halve
    // the addresses it can watch.
    onMempoolAction(address, callback) {
        const ws = this._requireWs();
        const onEvent = entityGuarded((msg) => frameIsForAddress(msg, address), callback);
        for (const t of MEMPOOL_EVENT_TYPES) ws.on(t, onEvent);

        // Bare `{ address }`, matching onAddress's default params exactly: the
        // refcount key is (channels, params), so adding a filter here would open a
        // separate subscription instead of joining the shared one.
        const params = { address };
        this._subscribeDetached(ws, ['address'], params);

        return oneShotTeardown(() => {
            for (const t of MEMPOOL_EVENT_TYPES) ws.off(t, onEvent);
            ws.unsubscribe(['address'], params);
        });
    },

    // Listen for token updates
    // Returns an unsubscribe function
    onToken(tick, callback) {
        const ws = this._requireWs();
        const onUpdate = entityGuarded((msg) => frameIdMatches(msg, 'tick', tick), callback);
        ws.on('TOKEN_UPDATE', onUpdate);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'token' && msg.data.tick === tick){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        const params = { tick, snapshot: true };
        this._subscribeDetached(ws, ['token'], params);
        return oneShotTeardown(() => {
            ws.off('TOKEN_UPDATE', onUpdate);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['token'], params);
        });
    },

    // Listen for market updates
    // Returns an unsubscribe function
    onMarket(tick1, tick2, callback) {
        const ws = this._requireWs();
        const onUpdate = entityGuarded(
            (msg) => frameIdMatches(msg, 'tick1', tick1) && frameIdMatches(msg, 'tick2', tick2),
            callback);
        ws.on('MARKET_UPDATE', onUpdate);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'market' &&
                msg.data.tick1 === tick1 && msg.data.tick2 === tick2){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        const params = { tick1, tick2, snapshot: true };
        this._subscribeDetached(ws, ['market'], params);
        return oneShotTeardown(() => {
            ws.off('MARKET_UPDATE', onUpdate);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['market'], params);
        });
    },

    // Listen for dispenser updates
    // Returns an unsubscribe function
    onDispenser(actionIndex, callback) {
        const ws = this._requireWs();
        // Two different fields name the dispenser, so the guards are not
        // interchangeable: DISPENSER_UPDATE is the entity's own frame and carries
        // `action_index`, while the lifecycle frames carry the DISPENSE's own
        // action_index and name their parent in `dispenser_action_index`
        // (ChangeDetector enriches it for exactly this correlation).
        const onUpdate    = entityGuarded((msg) => frameIdMatches(msg, 'action_index', actionIndex), callback);
        const onLifecycle = entityGuarded((msg) => frameIdMatches(msg, 'dispenser_action_index', actionIndex), callback);
        ws.on('DISPENSER_UPDATE', onUpdate);
        ws.on('DISPENSE', onLifecycle);
        ws.on('DISPENSER_CLOSED', onLifecycle);
        ws.on('DISPENSER_EXPIRED', onLifecycle);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'dispenser' &&
                String(msg.data.action_index) === String(actionIndex)){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        const params = { action_index: actionIndex, snapshot: true };
        this._subscribeDetached(ws, ['dispenser'], params);
        return oneShotTeardown(() => {
            ws.off('DISPENSER_UPDATE', onUpdate);
            ws.off('DISPENSE', onLifecycle);
            ws.off('DISPENSER_CLOSED', onLifecycle);
            ws.off('DISPENSER_EXPIRED', onLifecycle);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['dispenser'], params);
        });
    },
};
