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
 * XChain Platform SDK - WebSocket Client
 *
 * Real-time event client wrapping the xchain-explorer WebSocket API.
 * Mirrors the ExplorerClient pattern: connection management,
 * subscription API, event dispatch, reconnection with catch-up.
 *
 ********************************************************************/

const wsModule = require('ws');

// Resolve the constructor across module-interop shapes. In Node, require('ws')
// IS the class. In a browser bundle the `ws` specifier is aliased to an ESM
// shim (xchain-wallet packages/core/src/shims/ws-browser.js), and the bundler
// hands CommonJS consumers an interop wrapper around that ESM namespace rather
// than the class itself, so prefer an explicit named/default export when the
// module object is not directly constructible.
const WebSocket = typeof wsModule === 'function'
    ? wsModule
    : ((wsModule && typeof wsModule.WebSocket === 'function' && wsModule.WebSocket)
        || (wsModule && typeof wsModule.default === 'function' && wsModule.default)
        || wsModule);

// readyState values, spelled out rather than read off the module.
//
// NEVER compare against WebSocket.OPEN here. Rollup/Vite wrap the ESM
// browser shim with getAugmentedNamespace(), which copies only the namespace
// KEYS (`default`, `WebSocket`) onto a constructible function. Static class
// properties such as OPEN and CONNECTING are not namespace keys, so they are
// dropped: in the wallet bundle `WebSocket.OPEN` evaluated to undefined, every
// `readyState === WebSocket.OPEN` guard was permanently false, and send()
// silently dropped every frame on an open, healthy socket. Result: no
// subscription was ever confirmed and every wallet notification channel was
// dead, with a 10s "No response for request id" warning as the only symptom.
// The readyState values are fixed by the WebSocket spec and by Node's `ws`, so
// a literal is both correct and immune to how the module gets bundled.
const WS_CONNECTING = 0;
const WS_OPEN       = 1;

// WS event-envelope schema version this SDK build understands. The explorer
// stamps every frame with `schema_version` (see xchain-explorer/src/ws/schema_version.js)
// so consumers can gate their parsing instead of silently mis-parsing a
// reshaped payload; keep this in sync with the explorer's WS_SCHEMA_VERSION.
const WS_SCHEMA_VERSION = 2;

// Network string -> explorer coin code, generated from the canonical coin
// registry (same convention as explorer.js): a display prefix ('' mainnet,
// 'T' testnet, 'R' regtest) prepended to the ticker (e.g. dogecoin-testnet -> TDOGE).
const coins = require('../../coins');
const NET_DISPLAY_PREFIX = { mainnet: '', testnet: 'T', regtest: 'R' };
const COIN_PREFIX_MAP = {};
for(const _tick of coins.ALLOWED_COINS)
    for(const _network of coins.NETWORKS)
        COIN_PREFIX_MAP[coins.COIN_FULL_NAME[_tick] + '-' + _network] = NET_DISPLAY_PREFIX[_network] + _tick;

module.exports = {
    WebSocket,
    WS_CONNECTING,
    WS_OPEN,
    WS_SCHEMA_VERSION,
    NET_DISPLAY_PREFIX,
    COIN_PREFIX_MAP
};
