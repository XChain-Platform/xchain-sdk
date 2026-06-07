/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
 * their axios baseURL as `url.startsWith('http') ? url : 'http://'+url+':'+port`,
 * so a full `https://` URL is used verbatim — correct scheme, no stray
 * dev port appended (public infra serves https on 443).
 *
 ********************************************************************/

// Public XChain Platform service hosts (https on 443; the explorer host
// also serves WebSocket, from which `wss://` is derived automatically).
const PUBLIC_HUB      = 'https://hub.xchain.io';
const PUBLIC_EXPLORER = 'https://explorer.xchain.io';
const PUBLIC_ENCODER  = 'https://encoder.xchain.io';

// True for any `*-regtest` network string (e.g. bitcoin-regtest).
function isRegtest(network) {
    return typeof network === 'string' && network.endsWith('-regtest');
}

// Coin path prefix used by the platform to route a shared service host to the
// right per-network backend: e.g. bitcoin-mainnet -> BTC, bitcoin-testnet ->
// TBTC, dogecoin-regtest -> RDOGE. Matches explorer.js COIN_PREFIX_MAP and the
// wallet chain descriptors. Returns null for an unknown network.
function coinPrefix(network) {
    let [chain, net] = String(network || '').split('-');
    let coin = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }[chain];
    let pre  = { mainnet: '', testnet: 'T', regtest: 'R' }[net];
    // Strict: reject unknown chain or network part (e.g. "bitcoin-foo").
    if (!coin || pre === undefined) return null;
    return pre + coin;
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
    coinPrefix,
    publicDefaults
};
