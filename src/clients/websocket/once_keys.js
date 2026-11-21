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
 * XChain Platform SDK - WebSocket Client, once-subscription bookkeeping
 *
 * The explorer removes a `once` subscription after its first matching frame
 * and says so with UNSUBSCRIBED { channel, <entity fields>, reason: 'once' }
 * (explorer src/ws/broadcaster/channels.js removeOnceSubscriptions). This
 * client keeps each subscription for reconnect replay, so it marks the spent
 * channel/entity key on the tracked entry instead of deleting it: a reconnect
 * then replays only the keys still live, and the refcount in subscriptions.js
 * stays intact. Mirrors the explorer's bundled browser client
 * (src/content/js/xchain_ws.js xcWsFrameKey, xchain_ws_catch_up.js
 * xcWsKeysOf, _noteOnceSpent and _liveRequests), including how each entity
 * value is normalised, so request keys and frame keys compare equal.
 *
 ********************************************************************/

'use strict';

// Every param that names an entity, and each entity channel's singular and plural
// request names. The third flag marks a channel whose singular name wins over the
// plural one, as the server's own token key resolution does.
const ENTITY_PARAMS = ['address', 'addresses', 'tick', 'ticks', 'tick1', 'tick2',
    'pairs', 'action_index', 'action_indexes', 'call_id', 'call_ids'];
const ENTITY_NAMES = {
    address:   ['address', 'addresses'],
    token:     ['tick', 'ticks', true],
    dispenser: ['action_index', 'action_indexes'],
    bet_feed:  ['action_index', 'action_indexes'],
    xcall:     ['call_id', 'call_ids'],
};

// The server keys a recognized bech32 address in lowercase, and bech32 allows one
// case per address.
function addressId(address) {
    const s = String(address);
    return /^[a-z0-9]+1[ac-hj-np-z02-9]{6,}$/i.test(s) && (s === s.toLowerCase() || s === s.toUpperCase())
        ? s.toLowerCase() : s;
}

function entityList(channel, p) {
    const names = ENTITY_NAMES[channel];
    if (channel === 'market')
        return Array.isArray(p.pairs) ? p.pairs : (p.tick1 !== undefined && p.tick2 !== undefined ? [[p.tick1, p.tick2]] : []);
    if (names[2]) return p[names[0]] !== undefined ? [p[names[0]]] : (p[names[1]] || []);
    return Array.isArray(p[names[1]]) ? p[names[1]] : (p[names[0]] !== undefined ? [p[names[0]]] : []);
}

// The server keys one channel of a request holds, each with the params naming just it.
function keysOf(channel, params) {
    const p = params || {};
    if (channel !== 'market' && !ENTITY_NAMES[channel]) return [{ id: '', set: {} }];
    const names = ENTITY_NAMES[channel];
    return entityList(channel, p).map((v) => {
        const set = {};
        if (channel === 'market') { set.tick1 = v[0]; set.tick2 = v[1]; } else set[names[0]] = v;
        let id = channel === 'market' ? v[0] + '|' + v[1] : String(v);
        if (channel === 'xcall') id = id.toLowerCase();
        else if (channel === 'address') id = addressId(id);
        return { id, set };
    });
}

// The channel and entity key an UNSUBSCRIBED frame names.
function frameKey(d) {
    let id = d.channel === 'market' ? d.tick1 + '|' + d.tick2
        : [d.address, d.tick, d.action_index, d.call_id].filter(v => v !== undefined)[0];
    id = id === undefined ? '' : String(id);
    return d.channel + ':' + (d.channel === 'xcall' ? id.toLowerCase() : id);
}

function isOnceSpendFrame(msg) {
    return !!msg && msg.type === 'UNSUBSCRIBED' && !!msg.data && msg.data.reason === 'once'
        && typeof msg.data.channel === 'string';
}

// Mark the spent key on every tracked once entry holding that channel.
function noteOnceSpent(client, data) {
    const key = frameKey(data);
    for (const sub of client._subscriptions || []) {
        if (sub.params && sub.params.once && Array.isArray(sub.channels) && sub.channels.includes(data.channel))
            (sub.spent = sub.spent || {})[key] = true;
    }
}

function hasSpentKeys(sub) {
    return !!sub && !!sub.spent && Object.keys(sub.spent).length > 0;
}

// The requests that replay `request` with its owner's spent keys left out: the
// request itself when nothing is spent, one single-key request per live key
// otherwise, and none once every key is spent. Each carries its owning entry.
function liveRequests(request, owner) {
    const spent = owner && owner.spent;
    if (!spent || Object.keys(spent).length === 0)
        return [{ channels: request.channels, params: request.params, owner }];
    const out = [];
    for (const channel of request.channels) {
        for (const key of keysOf(channel, request.params)) {
            if (spent[channel + ':' + key.id]) continue;
            const params = {};
            for (const name of Object.keys(request.params || {}))
                if (!ENTITY_PARAMS.includes(name)) params[name] = request.params[name];
            out.push({ channels: [channel], params: Object.assign(params, key.set), owner });
        }
    }
    return out;
}

module.exports = { ENTITY_PARAMS, ENTITY_NAMES, addressId, keysOf, frameKey, isOnceSpendFrame,
    noteOnceSpent, hasSpentKeys, liveRequests };
