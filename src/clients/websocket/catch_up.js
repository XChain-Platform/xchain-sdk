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
 * XChain Platform SDK - WebSocket Client, reconnect catch-up
 *
 * The explorer runs one catch-up per connection and refuses an overlapping
 * one with CATCH_UP_IN_PROGRESS, so a reconnect replays each subscription
 * that can carry NEW_ACTION from the reconnect-time cursor ONE AT A TIME,
 * waiting for its CATCH_UP_COMPLETE or refusal before sending the next. A
 * truncated replay is continued from where the server stopped; a refused or
 * unanswered one emits `resync_required` so the caller can backfill over
 * REST. Mirrors the explorer's bundled browser client
 * (src/content/js/xchain_ws_catch_up.js).
 *
 * Plain functions over the client rather than prototype methods, so the
 * client's public method surface is unchanged.
 *
 ********************************************************************/

'use strict';

// Continuations past this many truncated rounds are reported as a gap instead. The
// server's depth limit means about eleven are ever needed.
const MAX_ROUNDS = 20;

// Only the actions and address channels ever carry NEW_ACTION, so only a subscription
// naming one of them has anything for a catch-up to replay.
function carriesActions(channels) {
    return Array.isArray(channels) && channels.some(c => c === 'actions' || c === 'address');
}

// The larger of two action indexes, compared as BigInt and kept as the wire's decimal
// string. A value that is not a non-negative integer literal is ignored (null included).
function maxIndex(current, raw) {
    if (raw === null || raw === undefined) return current;
    const val = String(raw);
    if (!/^[0-9]+$/.test(val)) return current;
    return (current === null || BigInt(val) > BigInt(current)) ? val : current;
}

// Track the cursor from one frame. WELCOME only seeds an unset cursor: its tip runs
// ahead of rows a reconnect replay has yet to deliver. While that replay runs, frames
// are noted in the catch-up state and applied once it closes.
function trackCursor(client, msg) {
    if (!msg.data) return;
    if (msg.type === 'WELCOME') {
        if (client.lastActionIndex === null) client.advanceCursor(msg.data.latest_action_index);
        return;
    }
    // Only NEW_ACTION and CATCH_UP_COMPLETE report a delivered action row. Other frames
    // reuse action_index for an entity id (a dispenser, a bet feed), and moving the
    // cursor to one would make the next reconnect skip rows this client never received.
    let raw;
    if (msg.type === 'NEW_ACTION') raw = msg.data.action_index;
    else if (msg.type === 'CATCH_UP_COMPLETE') raw = msg.data.latest_action_index;
    else return;
    const state = client._catchUp;
    if (state) {
        state.maxSeen = maxIndex(state.maxSeen, raw);
        return;
    }
    client.advanceCursor(raw);
}

// Cancel the pending request's backstop timer, if one is armed.
function clearTimer(state) {
    if (state && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
}

// Abandon a catch-up WITHOUT applying what it saw (a close or a fresh resubscribe): the
// cursor still points before the gap, so the next reconnect replays it again.
function dropCatchUp(client) {
    clearTimer(client._catchUp);
    client._catchUp = null;
}

// Every queued replay has closed: apply the highest index seen while they ran.
function finishCatchUp(client) {
    const state = client._catchUp;
    dropCatchUp(client);
    client.catchingUp = false;
    if (state) client.advanceCursor(state.maxSeen);
}

// (Re)send the current subscription with since_action_index and a fresh request id,
// which the server echoes on the CATCH_UP_COMPLETE or error that answers it.
function sendCatchUp(client, since) {
    const state   = client._catchUp;
    const current = state.current;
    current.id    = 'catchup-' + (client.nextId++);
    current.since = since;
    clearTimer(state);
    // Backstop: a replay that fails server-side may send nothing, so an unanswered
    // request is treated as refused instead of stalling the queue behind it.
    state.timer = setTimeout(() => {
        if (client._catchUp === state) refuseCatchUp(client, 'CATCH_UP_TIMEOUT', 'No reply to the catch-up request');
    }, client.catchUpTimeoutMs);
    if (state.timer.unref) state.timer.unref();
    const params = Object.assign({}, current.sub.params, { since_action_index: since });
    client.send({ action: 'subscribe', id: current.id, channels: current.sub.channels, params });
}

// Send the next queued subscription with its catch-up, or close the catch-up when none
// remain.
function nextCatchUp(client) {
    const state = client._catchUp;
    if (!state) return;
    const sub = state.queue.shift();
    if (!sub) {
        finishCatchUp(client);
        return;
    }
    state.current = { sub, rounds: 0, id: null, since: null };
    sendCatchUp(client, state.cursor);
}

// The pending catch-up was refused or went unanswered, so its rows were not replayed:
// emit resync_required (backfill over REST), then move on.
function refuseCatchUp(client, code, message) {
    const state = client._catchUp;
    if (!state || !state.current) return;
    clearTimer(state);
    client.emit('resync_required', {
        code:               code || null,
        message:            message || null,
        channels:           state.current.sub.channels,
        since_action_index: state.current.since
    });
    nextCatchUp(client);
}

// Handle a CATCH_UP_COMPLETE or error frame; only one carrying the pending request's id
// is an answer to it.
function answerCatchUp(client, msg) {
    const state = client._catchUp;
    if (!state || !state.current || msg.id === undefined || msg.id !== state.current.id) return;
    if (msg.type === 'error') {
        const err = msg.data || {};
        refuseCatchUp(client, err.code, err.message);
        return;
    }
    if (msg.type !== 'CATCH_UP_COMPLETE') return;
    const data = msg.data || {};
    // The server stopped at its row cap: continue from where it stopped. A once
    // subscription already spent by a replayed frame is not re-armed.
    const spentOnce = state.current.sub.params && state.current.sub.params.once && data.events_replayed > 0;
    if (data.truncated === true && !spentOnce) {
        if (++state.current.rounds >= MAX_ROUNDS) {
            refuseCatchUp(client, 'CATCH_UP_ROUNDS', 'Catch-up did not reach the tip in ' + MAX_ROUNDS + ' rounds');
            return;
        }
        sendCatchUp(client, data.latest_action_index);
        return;
    }
    clearTimer(state);
    nextCatchUp(client);
}

// Replay every tracked subscription after a reconnect. With a cursor to resume from,
// the ones that can carry NEW_ACTION are queued and sent one at a time.
function resubscribe(client) {
    dropCatchUp(client);
    // Same gate as before the cursor became a string: a chain still at index 0 gets no
    // since_action_index, so an unseeded reconnect cannot replay from genesis.
    const cursor = (client.lastActionIndex !== null && BigInt(client.lastActionIndex) > 0n) ? client.lastActionIndex : null;
    const queue  = [];
    for (const sub of client._subscriptions) {
        if (cursor !== null && carriesActions(sub.channels)) {
            queue.push(sub);
            continue;
        }
        client.send({ action: 'subscribe', channels: sub.channels, params: Object.assign({}, sub.params) });
    }
    if (queue.length > 0) {
        client._catchUp = { queue, cursor, current: null, maxSeen: null, timer: null };
        nextCatchUp(client);
    }
}

module.exports = { MAX_ROUNDS, trackCursor, answerCatchUp, resubscribe, dropCatchUp };
