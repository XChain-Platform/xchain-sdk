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
 * XChain Platform SDK - per-coin ticker-id lookup
 *
 ********************************************************************/

'use strict';

function createCoinTickLookup({ explorers, cap, cache = new Map() }) {
    if (explorers === null || typeof explorers !== 'object')
        throw new TypeError('explorers must be an object');
    if (typeof cap !== 'function') throw new TypeError('cap must be a function');

    return async function lookup(coin, rest) {
        const chain = String(coin).toUpperCase();
        const key = chain + ':' + String(rest).toLowerCase();
        if (cache.has(key)) return cache.get(key);

        const client = explorers[chain];
        if (!client || typeof client.getToken !== 'function') return null;

        let token;
        try {
            token = await cap(Promise.resolve().then(() => client.getToken(rest, { noRetry: true })));
        } catch (error) {
            return null;
        }

        const info = token && (Array.isArray(token) ? (token[0] || {}).info : token.info);
        if (!info || info.tick_id === undefined || info.tick_id === null) return null;

        const id = String(info.tick_id);
        if (!/^[0-9]+$/.test(id)) return null;

        cache.set(key, id);
        return id;
    };
}

module.exports = { createCoinTickLookup };
