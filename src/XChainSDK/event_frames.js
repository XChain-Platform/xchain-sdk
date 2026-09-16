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

/*
 * PER-ENTITY DELIVERY GUARDS FOR THE on*() SUBSCRIPTIONS
 *
 * WebSocketClient dispatches purely on `msg.type` (websocket.js _handleMessage),
 * so every handler registered for a type sees every frame of that type on the
 * socket. The explorer multiplexes several entity subscriptions over ONE socket
 * and stamps each frame with the entity it belongs to, so two same-type
 * subscriptions on one SDK instance - onToken('PEPE') and onToken('DOGE'), or one
 * onAddress per wallet address - both fired for either entity's frame and each
 * callback silently read the other entity's live data. The SNAPSHOT handlers in
 * those same methods already filtered; these give the LIVE handlers the same
 * discriminator.
 *
 * They fail OPEN on a frame that carries no discriminator, and that is the whole
 * design. The entity-update frames (ADDRESS_UPDATE / TOKEN_UPDATE / MARKET_UPDATE
 * / DISPENSER_UPDATE) always carry their entity id, but the lifecycle frames
 * (ORDER_MATCH, SWAP_MATCH, COINPAY_*, DISPENSE, DISPENSER_CLOSED/EXPIRED) carry
 * whatever field that event has and the server routes them by exactly that:
 * Broadcaster._extractAddresses reads source / destination / payer_address /
 * payee_address / address, and an ORDER_MATCH naming none of them is routed to
 * nobody's address channel. So filter on positive evidence the frame belongs to
 * SOMEONE ELSE, never on the absence of a field: a strict equality test against a
 * field the frame does not carry drops every one of these events, which trades a
 * routing bug for silent data loss.
 *
 * Known bound: NEW_ACTION is routed to the DESTINATION's address channel from the
 * raw action row, while its published `data` deliberately omits `destination`
 * (Broadcaster._onAction). That branch is inert today because the actions feed
 * never selects a destination column; if it is ever populated, the frame must
 * carry the field before this guard can honour it.
 */

// The SINGULAR address fields an explorer frame can name its party in, mirroring
// Broadcaster._extractAddresses on the server side.
//
// `destination` stays on this list even though the confirmed-side NEW_ACTION
// retired it in favour of the `destinations` array below. Two reasons, both
// about what the SERVER still does: _extractAddresses reads `destination` to
// this day and routes every lifecycle frame by it, and this guard filters on
// positive evidence a frame belongs to SOMEONE ELSE. Dropping the field could
// therefore only ADD deliveries, handing a subscriber a frame whose only named
// party is a different address; keeping it costs nothing, because a frame that
// does not carry the field is unaffected by a rule about the field.
const FRAME_ADDRESS_FIELDS = ['address', 'source', 'destination', 'payer_address', 'payee_address'];

// The ARRAY address field. Mempool frames on an address channel name their
// recipients only here (`{tx_hash, source, action, data, first_seen,
// destinations}`), and M1.4's NEW_ACTION uses the same field and semantics, so
// a guard that walked the singular fields alone rejected a correctly-routed
// delivery to the RECIPIENT: the frame names `source`, the source is not the
// subscriber, and "named by someone else" is a rejection. Absent on the GLOBAL
// mempool channel's frames by design (the matched set is derived from the
// server's own subscriber list), so it is never assumed present.
const FRAME_ADDRESS_ARRAY_FIELD = 'destinations';

/*
 * Every frame type the explorer routes to an address channel.
 *
 * Two of them are the Broadcaster's own: NEW_ACTION (_onAction, to the source's
 * and destination's channels) and ADDRESS_UPDATE (the entity's own frame). The
 * rest are the LIFECYCLE union, because _onLifecycleEvent fans EVERY lifecycle
 * event out to the address channel of each address _extractAddresses finds in
 * its data, independently of the event's own entity channel. So a name missing
 * from this list is not an event the client declines: it is a frame the server
 * sends over the already-open socket and the client silently drops, and only a
 * caller keyed on msg.type can tell.
 *
 * The producer's authority is three constants in the explorer's ChangeDetector
 * (LIFECYCLE_MAP values, NON_ACTION_LIFECYCLE_TYPES, INLINE_LIFECYCLE_TYPES);
 * test/unit/address_event_coverage.test.js reconciles this list against them,
 * so the two cannot separate again unnoticed.
 */
// Frozen because it is exported: every onAddress subscription on the process
// registers from this one array, so a consumer splicing it would silently
// change delivery for all of them.
const ADDRESS_EVENT_TYPES = Object.freeze([
    'NEW_ACTION', 'ADDRESS_UPDATE',
    // Unconfirmed (pre-validation) frames, Broadcaster-level like the two above
    // and likewise absent from the ChannelManager's `types` subscribe
    // vocabulary. Until they were listed here onAddress registered no handler
    // for them, so the explorer sent them over the open socket and the client
    // dropped them silently: the exact failure the comment above describes.
    'MEMPOOL_ACTION', 'MEMPOOL_REMOVED',
    'ORDER_MATCH', 'ORDER_EXPIRED',
    'COINPAY_REQUIRED', 'COINPAY_FULFILLED', 'COINPAY_EXPIRED',
    'SWAP_MATCH', 'SWAP_EXPIRED',
    'DISPENSE', 'DISPENSER_CLOSED', 'DISPENSER_EXPIRED',
    'BET', 'BET_EXPIRED', 'BET_CLOSED',
    'ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE',
    // Cross-chain call resolution. The Broadcaster routes every lifecycle event
    // to the address channel of each address it names, so these arrive on an
    // address subscription whether or not the consumer also watches the xcall
    // channel; absent from this list, onAddress registered no handler and the
    // frames were sent and dropped in silence, exactly as MEMPOOL_ACTION was.
    'XCALL_COMPLETED', 'XCALL_EXPIRED'
]);

// The unconfirmed subset of the roster above, registered by onMempoolAction.
// MEMPOOL_REMOVED rides along because a consumer that is shown a pending entry
// has to be told when it leaves the mempool (confirmed or evicted, which the
// explorer cannot distinguish); without it a phantom row never reconciles away.
// Frozen for the same reason as ADDRESS_EVENT_TYPES: it is exported.
const MEMPOOL_EVENT_TYPES = Object.freeze(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);

// Canonical decimal action_index, mirroring the explorer ChannelManager's
// CANONICAL_INDEX: no sign, no leading zeros, no fraction, no trailing junk.
const CANONICAL_ACTION_INDEX = /^(0|[1-9][0-9]*)$/;

// Canonical form of an xcall subscription key: the 64-hex call_id. Mirrors the
// explorer ChannelManager's CANONICAL_CALL_ID, which refuses anything else at
// subscribe time, so validating here turns a silent no-events subscription into
// an immediate throw naming the argument.
const CANONICAL_CALL_ID = /^[0-9a-f]{64}$/;

// Wrap a teardown closure so it releases its subscription AT MOST ONCE.
//
// ws.subscribe/unsubscribe are refcounted, so a second call on the same teardown
// decrements a count another holder still relies on and ends SOMEONE ELSE'S
// delivery, with no error anywhere. Unbalanced callers are ordinary (a cleanup
// that also runs on an error path, a component that tears down twice), so every
// on* teardown this module hands out goes through here.
function oneShotTeardown(fn) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        fn();
    };
}

// Every on* helper below captures its subscribe params in ONE object and hands
// that SAME object to ws.unsubscribe.
//
// WebSocketClient tracks a subscription under the exact (channels, params) pair
// and matches a release against it by the JSON of both, so a teardown that
// rebuilds params in a different shape releases nothing: the replay entry keeps
// a live refcount, the server unsubscribe is never sent, and the channel is
// re-subscribed on every reconnect for the life of the client. Sharing one
// object makes the two sides structurally identical instead of leaving them a
// convention that a single edit to the subscribe shape can break.
//
// Non-entity params (`types`, `snapshot`) ride along on the unsubscribe frame
// harmlessly. The explorer's ChannelManager.unsubscribe resolves an entity
// channel from the entity fields alone (address/addresses, tick, tick1+tick2,
// action_index) and builds no filter object at all, and a global channel is
// released by name with params untouched. The frame therefore names exactly the
// subscription the subscribe opened, and nothing else.

function frameData(msg) {
    return (msg && typeof msg === 'object' && msg.data && typeof msg.data === 'object') ? msg.data : null;
}

function frameIsForAddress(msg, address) {
    const data = frameData(msg);
    if (!data) return true;
    let named = false;

    // The array field first, because it is the only one that names the RECIPIENT
    // of an unconfirmed transaction. An EMPTY array deliberately does not count
    // as "named": it names nobody, so letting it set the flag would flip the
    // fail-open rule above into a rejection for a frame that identifies no party
    // at all (the global-channel mempool shape, which carries no destinations key
    // whatsoever, takes the same path).
    const destinations = data[FRAME_ADDRESS_ARRAY_FIELD];
    if (Array.isArray(destinations)) {
        for (const value of destinations) {
            if (value === undefined || value === null || value === '') continue;
            named = true;
            if (value === address) return true;
        }
    }

    for (const field of FRAME_ADDRESS_FIELDS) {
        const value = data[field];
        if (value === undefined || value === null || value === '') continue;
        named = true;
        if (value === address) return true;
    }
    return !named;
}

// Compare one stamped id field, string-normalized (action_index arrives as a
// number or a string depending on the frame).
function frameIdMatches(msg, field, expected) {
    const data = frameData(msg);
    if (!data) return true;
    const value = data[field];
    if (value === undefined || value === null || value === '') return true;
    return String(value) === String(expected);
}

// One wrapper per registration; the unsubscribe closure must ws.off THIS
// reference, not the caller's callback, or the handler stays attached.
function entityGuarded(predicate, callback) {
    return (msg) => { if (predicate(msg)) callback(msg); };
}

// Export frame guards together so every subscription applies one identity policy.
module.exports = {
    ADDRESS_EVENT_TYPES,
    MEMPOOL_EVENT_TYPES,
    CANONICAL_ACTION_INDEX,
    CANONICAL_CALL_ID,
    oneShotTeardown,
    frameData,
    frameIsForAddress,
    frameIdMatches,
    entityGuarded,
};
