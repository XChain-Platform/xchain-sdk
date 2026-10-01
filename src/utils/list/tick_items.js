// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const {
    parseTickCoinItem,
    isTickCoinRestWellFormed
} = require('../../protocol/list_tick_coin.js');
const { mapWithLimit } = require('./map_limit.js');

const LIST_TICK_LOOKUP_CONCURRENCY = 8;
const LOOKUP_COINS = new Set(['BTC', 'LTC', 'DOGE']);
const CANONICAL_DECIMAL_ID = /^[1-9][0-9]*$/;

function canonicalLookupId(id) {
    if (Number.isSafeInteger(id) && id > 0) return String(id);
    if (typeof id !== 'string' || !CANONICAL_DECIMAL_ID.test(id)) return null;
    return Number.isSafeInteger(Number(id)) ? id : null;
}

async function compactTickItems(items, lookup, concurrency = LIST_TICK_LOOKUP_CONCURRENCY) {
    return mapWithLimit(items, concurrency, async (item) => {
        const parsed = parseTickCoinItem(item);
        if (parsed === null || !LOOKUP_COINS.has(parsed.coin)) return item;
        if (parsed.rest.startsWith('^') ||
            !isTickCoinRestWellFormed(parsed.rest, parsed.canonical)) return item;

        try {
            const id = canonicalLookupId(await lookup(parsed.coin, parsed.rest));
            return id === null ? item : parsed.coin + ':^' + id;
        } catch (_) {
            return item;
        }
    });
}

module.exports = { LIST_TICK_LOOKUP_CONCURRENCY, compactTickItems };
