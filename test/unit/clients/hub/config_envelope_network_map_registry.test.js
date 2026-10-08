// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const coins = require('../../../../src/coins');
const { buildNetworkMap, NETWORK_MAP } = require('../../../../src/clients/hub/config_envelope');
const { COIN_PREFIX_MAP } = require('../../../../src/clients/websocket/socket_constants');

describe('config_envelope NETWORK_MAP registry derivation', () => {
    it('covers every registry coin and network, keyed like COIN_PREFIX_MAP', () => {
        const expected = coins.ALLOWED_COINS.flatMap(t => coins.NETWORKS.map(n => coins.COIN_FULL_NAME[t] + '-' + n));
        assert.deepStrictEqual(Object.keys(NETWORK_MAP).sort(), expected.sort());
        assert.deepStrictEqual(Object.keys(NETWORK_MAP).sort(), Object.keys(COIN_PREFIX_MAP).sort());
    });

    it('gives a coin added to the registry hub config keys', () => {
        const registry = {
            ALLOWED_COINS: ['BTC', 'FOO'],
            NETWORKS: ['mainnet', 'testnet'],
            COIN_FULL_NAME: { BTC: 'bitcoin', FOO: 'foocoin' }
        };
        const map = buildNetworkMap(registry);
        assert.deepStrictEqual(map['foocoin-testnet'], { coin: 'foocoin', network: 'testnet' });
        assert.strictEqual(Object.keys(map).length, 4);
    });
});
