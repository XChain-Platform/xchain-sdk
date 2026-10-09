// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The network-tier letters ('' / 'T' / 'R') have one definition, TIER_PREFIX in
// utils/endpoints.js, so a tier change there reaches the WebSocket coin map too.

const { expect } = require('chai');
const { TIER_PREFIX, coinPrefix } = require('../../../src/utils/endpoints.js');
const { COIN_PREFIX_MAP, NET_DISPLAY_PREFIX } = require('../../../src/clients/websocket/socket_constants.js');

describe('network-tier letters have a single source', function () {

    it('TIER_PREFIX is exported and frozen', function () {
        expect(TIER_PREFIX).to.deep.equal({ mainnet: '', testnet: 'T', regtest: 'R' });
        expect(Object.isFrozen(TIER_PREFIX)).to.equal(true);
    });

    it('every COIN_PREFIX_MAP entry equals coinPrefix of its network', function () {
        const keys = Object.keys(COIN_PREFIX_MAP);
        expect(keys.length).to.be.greaterThan(0);
        for (const k of keys) expect(COIN_PREFIX_MAP[k], k).to.equal(coinPrefix(k));
    });

    it('NET_DISPLAY_PREFIX is the TIER_PREFIX object, not a second copy', function () {
        expect(NET_DISPLAY_PREFIX).to.equal(TIER_PREFIX);
    });
});
