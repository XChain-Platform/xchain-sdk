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
 * XChain Platform SDK - Public Service Endpoint Defaults
 *
 * Zero-config service hosts. When the SDK is constructed with only a
 * `network` (no explicit explorer/encoder/hub URLs and no env overrides),
 * non-regtest networks default to the public XChain Platform hosts below.
 * Regtest is inherently local, so it falls through to each client's own
 * `localhost` fallback (these helpers return nothing for regtest).
 *
 * The constants are FULL URLs (with scheme). The service clients build
 * their axios baseURL as `hasHttpScheme(url) ? url : 'http://'+url+':'+port`,
 * so a full `https://` URL is used verbatim (correct scheme, no stray
 * dev port appended (public infra serves https on 443).
 *
 ********************************************************************/

const coins = require('../coins');

// Public XChain Platform service hosts (https on 443; the explorer host
// also serves WebSocket, from which `wss://` is derived automatically).
const PUBLIC_HUB      = 'https://hub.xchain.io';
const PUBLIC_EXPLORER = 'https://explorer.xchain.io';
const PUBLIC_ENCODER  = 'https://encoder.xchain.io';

// True for any `*-regtest` network string (e.g. bitcoin-regtest).
function isRegtest(network) {
    return typeof network === 'string' && network.endsWith('-regtest');
}

// Network tier -> the letter a coin code carries for it (TBTC, RDOGE).
const TIER_PREFIX = Object.freeze({ mainnet: '', testnet: 'T', regtest: 'R' });

// True when `table` holds `key` itself (an inherited name like 'constructor' is not a key).
function ownKey(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key);
}

// Coin path prefix the platform routes a shared service host by: bitcoin-mainnet
// -> BTC, bitcoin-testnet -> TBTC, dogecoin-regtest -> RDOGE. The explorer and
// WebSocket clients both resolve here; websocket/socket_constants.js COIN_PREFIX_MAP
// and the wallet chain descriptors use the same convention. Null when unknown.
function coinPrefix(network) {
    let parts = String(network || '').split('-');
    // Strict: exactly "<chain>-<tier>", both registry keys of their own, so
    // "bitcoin-foo", "bitcoin-mainnet-x" and "constructor-mainnet" all give null.
    if (parts.length !== 2) return null;
    if (!ownKey(coins.FULL_NAME_TO_TICK, parts[0]) || !ownKey(TIER_PREFIX, parts[1])) return null;
    return TIER_PREFIX[parts[1]] + coins.FULL_NAME_TO_TICK[parts[0]];
}

// Network tier letter ('', 'T' or 'R') of a coin code such as TDOGE, read
// from the coin registry so a newly added coin keeps its tier. '' when unknown.
function coinTier(code) {
    for (const tick of coins.ALLOWED_COINS)
        for (const net of coins.NETWORKS)
            if (TIER_PREFIX[net] + tick === code) return TIER_PREFIX[net];
    return '';
}

// Coin and network of a coin code, any case (TLTC -> { coin: 'LTC', network: 'testnet' }),
// read from the coin registry and TIER_PREFIX so a newly added coin decodes. Null when unknown.
function parseCoinCode(code) {
    const upper = String(code || '').toUpperCase();
    for (const tick of coins.ALLOWED_COINS)
        for (const net of coins.NETWORKS)
            if (TIER_PREFIX[net] + tick === upper) return { coin: tick, network: net };
    return null;
}

// True when `url` already carries an http:// or https:// scheme. A bare host
// that merely starts with "http" (httpgw.internal) is not a URL yet.
function hasHttpScheme(url) {
    return /^https?:\/\//.test(String(url || ''));
}

// True when `url` carries the https:// scheme (picks the https agent).
function isHttpsUrl(url) {
    return /^https:\/\//.test(String(url || ''));
}

// Network-derived public defaults. Returns {} for regtest (or a missing
// network), so the caller's `options || env || publicDefaults().X` chain
// resolves to undefined there and each client keeps its localhost fallback.
//
// The platform routes every shared service host by coin path (/{COIN}); see the
// wallet chain descriptors. The encoder and hub clients send to that URL
// verbatim, so their defaults must carry the /{COIN} segment. The explorer
// client builds its own /{COIN}/api/... path, so its default stays bare (adding
// the coin here would double it).
function publicDefaults(network) {
    if (!network || isRegtest(network)) return {};
    let coin = coinPrefix(network);
    if (!coin) return {};
    return {
        hubUrl:      PUBLIC_HUB + '/' + coin,
        explorerUrl: PUBLIC_EXPLORER,
        encoderUrl:  PUBLIC_ENCODER + '/' + coin
    };
}

module.exports = {
    PUBLIC_HUB,
    PUBLIC_EXPLORER,
    PUBLIC_ENCODER,
    isRegtest,
    TIER_PREFIX,
    coinPrefix,
    coinTier,
    parseCoinCode,
    hasHttpScheme,
    isHttpsUrl,
    publicDefaults
};
