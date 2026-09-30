// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pure parser for a coin-qualified ticker list item (`COIN:^<tickid>` or
// `COIN:TICK`). This is the SDK's copy of the indexer's item rule; it reads
// no activation gate and makes no network call.
const { FULL_NAME_TO_TICK } = require('../coins/index.js');
const { RESERVED_FUTURE_ROOTS } = require('../preflight/constants.js');
const { TICK_REGEX, MAX_TICK_LENGTH } = require('../cosigner/policy/param_charset.js');

const LIST_TICK_COIN_SEPARATOR = ':';
const LIST_TICK_COIN_MAX_ITEM_LENGTH = 200;

const CANONICAL_CARET_REST = /^\^[1-9][0-9]*$/;
const DEFAULT_COINS = Object.values(FULL_NAME_TO_TICK);

// Upper-cased root when the text before the first separator is a coin or a
// reserved future root; null for anything else, so such an item stays bare.
function coinQualifierRoot(text, coins = DEFAULT_COINS){
    if(typeof text !== 'string') return null;
    const at = text.indexOf(LIST_TICK_COIN_SEPARATOR);
    if(at <= 0) return null;
    const root = text.slice(0, at).toUpperCase();
    const isCoin = Array.isArray(coins) && coins.some((coin) =>
        typeof coin === 'string' && coin.toUpperCase() === root
    );
    if(isCoin) return root;
    return RESERVED_FUTURE_ROOTS.includes(root) ? root : null;
}

// null for a bare item, else the coin, the rest exactly as written and the
// canonical form with the root upper-cased.
function parseTickCoinItem(item, coins = DEFAULT_COINS){
    const coin = coinQualifierRoot(item, coins);
    if(coin === null) return null;
    const rest = item.slice(item.indexOf(LIST_TICK_COIN_SEPARATOR) + 1);
    return { coin, rest, canonical: coin + LIST_TICK_COIN_SEPARATOR + rest };
}

function isTickCoinRestWellFormed(rest, canonical){
    if(typeof rest !== 'string' || typeof canonical !== 'string') return false;
    if(canonical.length > LIST_TICK_COIN_MAX_ITEM_LENGTH) return false;
    if(rest.startsWith('^')) return CANONICAL_CARET_REST.test(rest);
    return rest.length >= 1 && rest.length <= MAX_TICK_LENGTH && TICK_REGEX.test(rest);
}

module.exports = {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    coinQualifierRoot,
    parseTickCoinItem,
    isTickCoinRestWellFormed,
};
