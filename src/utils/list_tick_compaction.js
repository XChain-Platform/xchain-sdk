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
 * XChain Platform SDK - ticker LIST item compaction
 *
 ********************************************************************/

'use strict';

const ExplorerClient = require('../clients/explorer.js');
const config = require('../config.js');
const { isListTickCoinActive } = require('../protocol/list_tick_coin.js');
const { buildCoinExplorers, COIN_NETWORK_PREFIX } = require('./list/coin_explorers.js');
const { createCoinTickLookup } = require('./list/coin_tick_lookup.js');
const { readParentListType } = require('./list/parent_list_type.js');
const { compactTickItems } = require('./list/tick_items.js');

function fieldKeys(resolver, params) {
    const fields = {};
    for (const key of Object.keys(params))
        fields[resolver.sdk.util.camelToUpperSnake(key)] = key;
    return fields;
}

function networkParts(sdk) {
    const network = sdk.options.network || (sdk.config && sdk.config.network) || config.env.network();
    const parts = String(network || '').toLowerCase().split('-');
    if (parts.length !== 2 || !['mainnet', 'testnet', 'regtest'].includes(parts[1])) return null;
    const coin = Object.keys(COIN_NETWORK_PREFIX).find(key => COIN_NETWORK_PREFIX[key] === parts[0]);
    return coin ? { coin, tier: parts[1] } : null;
}

function coinExplorers(resolver) {
    const sdk = resolver.sdk;
    const parts = networkParts(sdk);
    if (!parts || !sdk.explorer) return null;

    if (!resolver.listCoinExplorers) {
        resolver.listCoinExplorers = {};
        for (const entry of buildCoinExplorers(sdk.explorer, parts.tier, ExplorerClient))
            resolver.listCoinExplorers[entry.chain] = entry.explorer;
    }
    resolver.listCoinExplorers[parts.coin] = sdk.explorer;
    return resolver.listCoinExplorers;
}

function coinTickLookup(resolver) {
    if (resolver.listCoinTickLookup) return resolver.listCoinTickLookup;
    const explorers = coinExplorers(resolver);
    if (!explorers) return null;
    resolver.listCoinTickLookup = createCoinTickLookup({
        explorers,
        cap: promise => resolver.withCap(promise, resolver.lookupCapMs)
    });
    return resolver.listCoinTickLookup;
}

async function compactListTickItems(resolver, params) {
    if (!resolver.enabled() || params === undefined || params === null
        || typeof params !== 'object' || Array.isArray(params)) return params;

    const fields = fieldKeys(resolver, params);
    if (fields.ITEM === undefined) return params;

    let listType = fields.TYPE === undefined ? null : params[fields.TYPE];
    if (listType !== null && String(listType) !== '1') return params;
    if (!await isListTickCoinActive(resolver.sdk)) return params;

    if (listType === null && fields.LIST_ACTION_INDEX !== undefined) {
        listType = await readParentListType(
            resolver.sdk.explorer,
            params[fields.LIST_ACTION_INDEX],
            promise => resolver.withCap(promise, resolver.lookupCapMs)
        );
    }
    if (String(listType) !== '1') return params;

    const lookup = coinTickLookup(resolver);
    if (!lookup) return params;
    const value = params[fields.ITEM];
    const input = Array.isArray(value) ? value : [value];
    const compacted = await compactTickItems(input, lookup);
    const out = Object.assign({}, params);
    out[fields.ITEM] = Array.isArray(value) ? compacted : compacted[0];
    return out;
}

module.exports = { compactListTickItems };
