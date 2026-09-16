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

const ActionWaiter = require('../utils/action_waiter.js');
const { CANONICAL_ACTION_INDEX, CANONICAL_CALL_ID, oneShotTeardown, frameData, frameIsForAddress, frameIdMatches, entityGuarded } = require('./event_frames.js');

// Keep event subscriptions together because they share validation and teardown rules.
module.exports = {

    // Listen for one betting market's live events: bets placed, the deadline
    // latch, resolve, cancel and expiry.
    // Returns an unsubscribe function.
    onBetFeed(feedActionIndex, callback) {
        const index = String(feedActionIndex === null || feedActionIndex === undefined ? '' : feedActionIndex).trim();
        // A feed is named by a plain number; anything else could never match a real feed.
        if (!CANONICAL_ACTION_INDEX.test(index))
            throw new Error('onBetFeed: feedActionIndex must be a numeric ACTION_INDEX, got ' + JSON.stringify(feedActionIndex));

        const ws = this.requireWs();
        // Guard on `feed_action_index`, NOT `action_index`. A BET frame's own
        // action_index is the individual bet; the parent market rides in
        // feed_action_index, which the ChangeDetector enriches for exactly this
        // correlation, and which the Broadcaster routes the channel on. Getting
        // this backwards is the dispenser_action_index bug onDispenser documents.
        // BET_CLOSED sets both fields to the feed id, so it matches either way.
        // Unlike a dispenser there is no entity-own update frame here (no
        // BET_FEED_UPDATE), so one lifecycle guard plus the SNAPSHOT filter is
        // the whole surface.
        const onLifecycle = entityGuarded((msg) => frameIdMatches(msg, 'feed_action_index', index), callback);
        ws.on('BET', onLifecycle);
        ws.on('BET_EXPIRED', onLifecycle);
        ws.on('BET_CLOSED', onLifecycle);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'bet_feed' &&
                String(msg.data.action_index) === index){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        // The channel NAME is bare and the market id rides in params: a composite
        // 'bet_feed:<index>' is rejected outright with `Unknown channel`, the same
        // trap documented on websocket.js subscribeBetFeed().
        const params = { action_index: index, snapshot: true };
        this.subscribeDetached(ws, ['bet_feed'], params);
        return oneShotTeardown(() => {
            ws.off('BET', onLifecycle);
            ws.off('BET_EXPIRED', onLifecycle);
            ws.off('BET_CLOSED', onLifecycle);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['bet_feed'], params);
        });
    },

    // Listen for one cross-chain call's terminal phases: XCALL_COMPLETED,
    // XCALL_EXPIRED and the initial SNAPSHOT.
    // Returns an unsubscribe function.
    onXcall(callId, callback) {
        // Lower-case, not just String(): the explorer normalizes the id at
        // subscribe time, so an upper-case id subscribes fine and receives nothing.
        const id = String(callId === null || callId === undefined ? '' : callId).trim().toLowerCase();
        // A call id is exactly 64 hex characters; reject anything else before subscribing to nothing.
        if (!CANONICAL_CALL_ID.test(id))
            throw new Error('onXcall: callId must be a 64-character hex string, got ' + JSON.stringify(callId));

        const ws = this.requireWs();
        // Compare the frame's own call_id case-insensitively, because only the
        // Broadcaster's ROUTING key is lower-cased, never the id inside `data`.
        // Fail open on a frame that carries no call_id, matching frameIdMatches:
        // the guard rejects on positive evidence of another call, never on silence.
        const matchesCall = (msg) => {
            const data = frameData(msg);
            if (!data) return true;
            const value = data.call_id;
            if (value === undefined || value === null || value === '') return true;
            return String(value).toLowerCase() === id;
        };
        // One lifecycle guard plus the SNAPSHOT filter is the whole surface: a call
        // has no entity-own update frame (no XCALL_UPDATE), exactly like bet_feed.
        const onLifecycle = entityGuarded(matchesCall, callback);
        ws.on('XCALL_COMPLETED', onLifecycle);
        ws.on('XCALL_EXPIRED', onLifecycle);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'xcall' &&
                String(msg.data.call_id).toLowerCase() === id){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        // Bare channel name with the id in params, like every sibling entity: a
        // composite 'xcall:<id>' is rejected outright with `Unknown channel`.
        const params = { call_id: id, snapshot: true };
        this.subscribeDetached(ws, ['xcall'], params);
        return oneShotTeardown(() => {
            ws.off('XCALL_COMPLETED', onLifecycle);
            ws.off('XCALL_EXPIRED', onLifecycle);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['xcall'], params);
        });
    },

    // Listen for oracle attestation traffic (both phases) on the global
    // `attestation` channel. No entity key and no snapshot: it is a stream, not
    // an entity with current state.
    // Returns an unsubscribe function.
    onAttestation(callback) {
        const ws = this.requireWs();
        // v0 is the request, v1 the response; the explorer splits them into two
        // type names because the raw action row carries no version to tell them
        // apart. No entity guard: a global channel has nothing to scope to.
        ws.on('ATTESTATION_REQUEST', callback);
        ws.on('ATTESTATION_RESPONSE', callback);
        this.subscribeDetached(ws, ['attestation']);
        return oneShotTeardown(() => {
            ws.off('ATTESTATION_REQUEST', callback);
            ws.off('ATTESTATION_RESPONSE', callback);
            ws.unsubscribe(['attestation']);
        });
    },

    // Shortcut: listen for COINPAY_REQUIRED events on an address
    // Returns an unsubscribe function
    onCoinpayRequired(address, callback) {
        const ws = this.requireWs();
        const onEvent = entityGuarded((msg) => frameIsForAddress(msg, address), callback);
        ws.on('COINPAY_REQUIRED', onEvent);
        const params = { address, types: ['COINPAY_REQUIRED'] };
        this.subscribeDetached(ws, ['address'], params);
        return oneShotTeardown(() => {
            ws.off('COINPAY_REQUIRED', onEvent);
            ws.unsubscribe(['address'], params);
        });
    },

    // Shortcut: listen for ORDER_MATCH events on an address
    // Returns an unsubscribe function
    onOrderMatch(address, callback, opts) {
        const ws = this.requireWs();
        const onEvent = entityGuarded((msg) => frameIsForAddress(msg, address), callback);
        ws.on('ORDER_MATCH', onEvent);
        const params = { address, types: ['ORDER_MATCH'] };
        this.subscribeDetached(ws, ['address'], params);
        return oneShotTeardown(() => {
            ws.off('ORDER_MATCH', onEvent);
            ws.unsubscribe(['address'], params);
        });
    },

    // Wait for a transaction to be indexed by the explorer
    // Returns the action object when found, or rejects on timeout
    // opts: { timeout, pollInterval, requireValid, explorer | explorerUrl+explorerPort }
    // The explorer override targets a stack other than the one this SDK
    // discovered, for isolated venues with no colocated explorer.
    async waitForAction(txid, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForTxid(txid, opts);
    },

    // Wait for a specific action_index to appear in the explorer.
    // Same explorer override as waitForAction.
    async waitForActionIndex(actionIndex, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForActionIndex(actionIndex, opts);
    },

    // Wait until a CONTRACT'S OWN state satisfies a condition, e.g.
    //   await sdk.waitForContractState(73, { key: 'status', equals: 'FUNDED' })
    // This is the gate a caller needs before settling against a contract: a
    // confirmed transaction, and even a visible action row, is earlier than the
    // indexer executing the action, and settling in that gap spends inputs the
    // pending action already used. opts: { key, equals, match, timeout,
    // pollInterval, explorer | explorerUrl+explorerPort }.
    async waitForContractState(contractActionIndex, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForContractState(contractActionIndex, opts);
    },

    // Wait until a contract HOLDS a token balance: the same gate for a DEPOSIT,
    // which credits the contract without writing any state key of its own.
    // opts adds minQuantity (default: any quantity above zero).
    async waitForContractBalance(contractActionIndex, tick, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForContractBalance(contractActionIndex, tick, opts);
    },

    // Listen for network stats updates
    // Returns an unsubscribe function
    onNetworkStats(callback) {
        const ws = this.requireWs();
        ws.on('NETWORK_STATS', callback);
        this.subscribeDetached(ws, ['network']);
        return oneShotTeardown(() => {
            ws.off('NETWORK_STATS', callback);
            ws.unsubscribe(['network']);
        });
    },
};
