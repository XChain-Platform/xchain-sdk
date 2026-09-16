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

module.exports = {
    // Bookkeeping key for one tracked subscription: the channel array and the
    // params, compared exactly as unsubscribe() has always compared them (the
    // JSON of the channels, and the JSON of `params || {}`). Keying on those same
    // two strings is deliberate: unsubscribeBetFeed documents that its params
    // object must be built IDENTICALLY to subscribeBetFeed's or the tracked entry
    // is never released, and that property has to survive refcounting. A looser
    // key (channel-only, or entity-only) would let one caller's teardown release
    // a subscription that was opened with a different server-side filter.
    subscriptionKey(channels, params) {
        // One JSON array rather than two strings joined by a separator: a
        // separator has to be a character neither side can contain, and the
        // obvious pick (a NUL) makes this file BINARY to grep and ripgrep, which
        // silently drops it out of every source-wide search. Encoding the pair
        // is unambiguous and keeps the file text.
        return JSON.stringify([channels, params || {}]);
    },

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
        const key      = this.subscriptionKey(channels, params);
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

        const pending = this.sendWithResponse(id, msg);

        // Track for reconnect replay. `params` is stored by reference, as it
        // always was, so resubscribe and the key see the same object.
        this._subscriptions.push({ key, channels, params: params || {}, refs: 1, pending });

        return pending;
    },

    // Subscribe to one betting market's live events: bet placed, deadline latch
    // (market closed), resolved, cancelled, expired. A market page uses this to
    // keep pool totals and implied odds current, which matters because a
    // parimutuel payout is only ever a projection until the market resolves.
    // Returns the same SUBSCRIBED promise as subscribe(), so reconnect replay
    // covers it automatically.
    // The channel NAME is bare and the market id rides in `params.action_index`.
    // A composite 'bet_feed:<index>' is rejected outright with `Unknown channel`:
    // the server validates the name
    // against a fixed set before ever looking at the entity key
    // (explorer ChannelManager: entity channels "require params"). The composite
    // form fails every subscribe, making the channel unreachable from the SDK.
    subscribeBetFeed(feedActionIndex, params) {
        const index = String(feedActionIndex == null ? '' : feedActionIndex).trim();
        if (!/^\d+$/.test(index))
            throw new Error('subscribeBetFeed: feedActionIndex must be a numeric ACTION_INDEX, got ' + JSON.stringify(feedActionIndex));
        return this.subscribe(['bet_feed'], Object.assign({}, params, { action_index: index }));
    },

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
    },

    // Refcounted counterpart of subscribe(): each call releases ONE holder, and
    // only the last one drops the replay entry and tells the server. An
    // unsubscribe for a (channels, params) this client is not tracking still
    // sends the frame, exactly as before, so a caller can cancel a subscription
    // it did not open through subscribe().
    unsubscribe(channels, params) {
        const key   = this.subscriptionKey(channels, params);
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

        this.send(msg);
    },

    // Returns a Promise resolved by SUBSCRIPTION_LIST response
    listSubscriptions() {
        const id = 'list-' + (this.nextId++);
        return this.sendWithResponse(id, { action: 'list_subscriptions', id });
    },

    on(eventType, callback) {
        if (!this._handlers[eventType]) this._handlers[eventType] = [];
        this._handlers[eventType].push(callback);
    },

    off(eventType, callback) {
        if (!this._handlers[eventType]) return;
        this._handlers[eventType] = this._handlers[eventType].filter(cb => cb !== callback);
    },

    once(eventType, callback) {
        const wrapper = (msg) => {
            this.off(eventType, wrapper);
            callback(msg);
        };
        this.on(eventType, wrapper);
    }
};
