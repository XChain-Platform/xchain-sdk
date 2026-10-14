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
 * XChain Platform SDK - WebSocket Client, outbound pacing
 *
 * The explorer drops a message over its per-connection rate (WELCOME's
 * limits.max_message_rate, a leaky bucket draining at that many per second)
 * with a RATE_LIMITED error that names the dropped request's id. A reconnect
 * with many tracked subscriptions would otherwise send them in one tick and
 * lose every one past the rate, so every outbound frame waits in a queue
 * until this client's own copy of that bucket has room, one slot short of the
 * server's for timing slack; under the rate a frame still goes out
 * synchronously. A reconnect's plain resubscribes carry request ids so one
 * the server drops is sent again.
 *
 * Plain functions over the client rather than prototype methods, so the
 * client's public method surface is unchanged.
 *
 ********************************************************************/

'use strict';

const { WS_OPEN } = require('./socket_constants.js');

// How many times one request dropped with RATE_LIMITED is sent again.
const RATE_RETRIES = 5;

// The server's advertised per-connection message rate, or the client's default before
// WELCOME arrives.
function messageRate(client) {
    const limits = client.serverInfo && client.serverInfo.limits;
    const rate = limits && Number(limits.max_message_rate);
    return (rate && rate > 0) ? rate : (client.defaultMessageRate || 10);
}

// One drain interval at the server's rate, in milliseconds: the wait before a retry or
// the next queued frame.
function drainInterval(client) {
    return Math.ceil(1000 / messageRate(client));
}

// Send queued frames while the local bucket has room, then wait one drain interval for
// the next slot. Frames queued for a socket that closed are dropped: the reconnect
// resubscribes from the tracked list.
function drainOut(client) {
    if (client._outTimer) return;
    const rate     = messageRate(client);
    const capacity = Math.max(1, rate - 1);
    while (client._outQueue.length > 0) {
        if (!client.ws || client.ws.readyState !== WS_OPEN) {
            client._outQueue = [];
            return;
        }
        const now = Date.now();
        client._outLevel = Math.max(0, client._outLevel - ((now - client._outAt) / 1000) * rate);
        client._outAt = now;
        if (client._outLevel + 1 > capacity) break;
        client._outLevel += 1;
        client.ws.send(JSON.stringify(client._outQueue.shift()));
    }
    if (client._outQueue.length === 0) return;
    client._outTimer = setTimeout(() => {
        client._outTimer = null;
        drainOut(client);
    }, drainInterval(client));
    if (client._outTimer.unref) client._outTimer.unref();
}

// Queue one frame for the open socket and send what the bucket allows now.
function sendPaced(client, data) {
    if (!client._outQueue) resetOut(client);
    client._outQueue.push(data);
    drainOut(client);
}

// Drop everything queued for the last socket, and its bucket: a new connection starts
// with an empty bucket on the server too. Pending resubscribes belong to the old socket.
function resetOut(client) {
    if (client._outTimer) clearTimeout(client._outTimer);
    client._outTimer = null;
    client._outQueue = [];
    client._outLevel = 0;
    client._outAt    = 0;
    client._pendingSubscribes = {};
}

// Send a reconnect's plain resubscribe with a request id, remembered until answered so
// a RATE_LIMITED refusal naming it can be retried (answerTrackedSubscribe).
function sendTrackedSubscribe(client, channels, params, attempt) {
    const id = 'resub-' + (client.nextId++);
    if (!client._pendingSubscribes) client._pendingSubscribes = {};
    client._pendingSubscribes[id] = { channels, params, attempt: attempt || 0 };
    // Through client.send, which paces it (sendPaced), so one send path covers every frame.
    client.send({ action: 'subscribe', id, channels, params });
}

// Close a tracked resubscribe on any answer naming it; a RATE_LIMITED refusal sends it
// again under a fresh id after one drain interval, unless the subscription was released
// meanwhile or it has been retried RATE_RETRIES times.
function answerTrackedSubscribe(client, msg) {
    const pending = client._pendingSubscribes;
    if (!pending || msg.id === undefined || !Object.prototype.hasOwnProperty.call(pending, msg.id)) return;
    const tracked = pending[msg.id];
    delete pending[msg.id];
    if (!isRateLimited(msg) || tracked.attempt >= RATE_RETRIES) return;
    if (!client._subscriptions.some(sub => sub.channels === tracked.channels)) return;
    const timer = setTimeout(() => {
        sendTrackedSubscribe(client, tracked.channels, tracked.params, tracked.attempt + 1);
    }, drainInterval(client));
    if (timer.unref) timer.unref();
}

// Handle a frame's bearing on rate-limited requests, and answer whether it was a
// RATE_LIMITED refusal of a request awaiting its answer (sendWithResponse) that was
// sent again, which the caller must then not settle. A tracked resubscribe the frame
// answers is closed or retried (answerTrackedSubscribe). A pending request is sent
// again under its own id after one drain interval, up to RATE_RETRIES times; past
// that the refusal settles it as before.
function answerRateLimited(client, msg) {
    answerTrackedSubscribe(client, msg);
    if (!msg.id || !isRateLimited(msg) || !Object.prototype.hasOwnProperty.call(client._pending, msg.id)) return false;
    const pending = client._pending[msg.id];
    if (!pending.msg || (pending.retries || 0) >= RATE_RETRIES) return false;
    pending.retries = (pending.retries || 0) + 1;
    const timer = setTimeout(() => {
        if (client._pending[msg.id] === pending) client.send(pending.msg);
    }, drainInterval(client));
    if (timer.unref) timer.unref();
    return true;
}

// A refusal the server sends for a message over its per-connection rate.
function isRateLimited(msg) {
    return msg.type === 'error' && !!msg.data && msg.data.code === 'RATE_LIMITED';
}

module.exports = {
    RATE_RETRIES, messageRate, drainInterval, sendPaced, resetOut,
    sendTrackedSubscribe, answerTrackedSubscribe, answerRateLimited, isRateLimited
};
