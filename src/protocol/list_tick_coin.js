// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { FULL_NAME_TO_TICK } = require('../coins/index.js');
const { RESERVED_FUTURE_ROOTS } = require('../preflight/constants.js');
const { activationThreshold } = require('../preflight/activation.js');
const { TICK_REGEX, MAX_TICK_LENGTH } = require('../cosigner/policy/param_charset.js');

const LIST_TICK_COIN_SEPARATOR = ':';
const LIST_TICK_COIN_MAX_ITEM_LENGTH = 200;
const LIST_TICK_COIN_READ_CAP_MS = 2000;

const CANONICAL_CARET_REST = /^\^[1-9][0-9]*$/;
const DEFAULT_COINS = Object.values(FULL_NAME_TO_TICK);

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

function requestTimeout(sdk, explorer){
    const sdkTimeout = sdk && sdk.options && Number(sdk.options.timeout);
    const explorerTimeout = explorer && Number(explorer.timeout);
    const configured = Number.isFinite(sdkTimeout) && sdkTimeout > 0
        ? sdkTimeout
        : explorerTimeout;
    return Number.isFinite(configured) && configured > 0
        ? Math.min(configured, LIST_TICK_COIN_READ_CAP_MS)
        : LIST_TICK_COIN_READ_CAP_MS;
}

function getStatusWithTimeout(sdk, explorer){
    const read = Promise.resolve().then(() => explorer.getStatus());
    const timeout = requestTimeout(sdk, explorer);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('LIST ticker activation read timed out')), timeout);
        read.then(
            (status) => { clearTimeout(timer); resolve(status); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

async function isListTickCoinActive(sdk){
    let threshold;
    try {
        threshold = activationThreshold('LIST_TICK_COIN', sdk);
    } catch (e) {
        return false;
    }
    if(!Number.isFinite(threshold)) return false;

    const explorer = sdk && sdk.explorer;
    if(!explorer || typeof explorer.getStatus !== 'function') return false;
    try {
        const status = await getStatusWithTimeout(sdk, explorer);
        const tip = status && status.last_block && status.last_block[explorer.coin];
        return Number.isFinite(tip) && tip + 1 >= threshold;
    } catch (e) {
        return false;
    }
}

module.exports = {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    coinQualifierRoot,
    parseTickCoinItem,
    isTickCoinRestWellFormed,
    isListTickCoinActive,
};
