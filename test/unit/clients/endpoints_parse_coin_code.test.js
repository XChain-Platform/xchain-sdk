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
 * XChain Platform SDK - Coin Code Decoding Tests
 *
 * parseCoinCode is the one reverse of coinPrefix: every coin code decoder in
 * preflight and the fee path reads through it, so a coin added to the
 * registry decodes with no other edit.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const coins = require('../../../src/coins');
const { TIER_PREFIX, parseCoinCode } = require('../../../src/utils/endpoints.js');
const { planeFromCoin } = require('../../../src/preflight/checks/issue.js');
const { activationThreshold } = require('../../../src/preflight/activation.js');

// The decoder every call site carried before the registry helper, kept here as the oracle.
function handWrittenDecode(code) {
    const m = /^([TR]?)(BTC|LTC|DOGE)$/.exec(String(code || '').toUpperCase());
    if (!m) return null;
    return { coin: m[2], network: m[1] === 'T' ? 'testnet' : m[1] === 'R' ? 'regtest' : 'mainnet' };
}

describe('endpoints parseCoinCode', function () {
    it('decodes every registry coin code built from TIER_PREFIX', function () {
        for (const tick of coins.ALLOWED_COINS)
            for (const net of coins.NETWORKS)
                expect(parseCoinCode(TIER_PREFIX[net] + tick)).to.deep.equal({ coin: tick, network: net });
    });

    it('matches the hand-written decoder on today\'s registry, case and junk included', function () {
        const codes = ['BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC', 'DOGE', 'TDOGE', 'RDOGE',
            'tbtc', 'Rdoge', 'XBTC', 'TTBTC', 'BTCX', 'GAS', '', null, undefined, 42,
            'constructor', '__proto__', 'toString'];
        for (const code of codes) expect(parseCoinCode(code), String(code)).to.deep.equal(handWrittenDecode(code));
    });

    it('decodes a coin added to the registry through the preflight plane', function () {
        coins.ALLOWED_COINS.push('FOO');
        try {
            expect(parseCoinCode('TFOO')).to.deep.equal({ coin: 'FOO', network: 'testnet' });
            expect(planeFromCoin('RFOO')).to.deep.equal({ coin: 'FOO', network: 'regtest' });
        } finally {
            coins.ALLOWED_COINS.pop();
        }
        expect(parseCoinCode('TFOO')).to.equal(null);
    });

    it('resolves an activation threshold from the explorer coin code alone', function () {
        const byCode = activationThreshold('LIST_ADDRESS_REF', { explorer: { coin: 'TBTC' } });
        const byNetwork = activationThreshold('LIST_ADDRESS_REF', { config: { network: 'bitcoin-testnet' } });
        expect(byCode).to.equal(byNetwork);
        expect(activationThreshold('LIST_ADDRESS_REF', { explorer: { coin: 'XBTC' } })).to.equal(undefined);
    });
});
