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
 * The multipart funding output floor used when a quote carries none: the DOGE
 * soft dust floor is exercised directly, and held equal to the encoder's
 * SOFT_DUST_FLOOR_BY_COIN wherever the encoder checkout is present.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    outputFloorOf,
    SOFT_DUST_FLOOR_BY_COIN,
} = require('../../../src/actions/workflows/file_multipart_wave_funding.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const ENCODER_DIR = process.env.XCHAIN_ENCODER_DIR || path.join(SIBLING_ROOT, 'xchain-encoder');

function fakeSdk(coin, dustThreshold) {
    return { wallet: { getBitcoinNetwork: () => ({ dustThreshold }) },
        requireExplorer: () => ({ coin }) };
}

function encoderSoftFloors() {
    const file = path.join(ENCODER_DIR, 'src', 'XChainEncoder', 'constants.js');
    if (!fs.existsSync(file)) return null;
    const match = /const SOFT_DUST_FLOOR_BY_COIN = \{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
    assert(match, 'encoder constants no longer declare SOFT_DUST_FLOOR_BY_COIN in the expected form');
    const floors = {};
    for (const row of match[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) floors[row[1]] = Number(row[2]);
    return floors;
}

describe('multipart funding output floor fallback', function () {
    it('uses the DOGE soft dust floor on a DOGE chain with no quoted floor', function () {
        for (const coin of ['DOGE', 'tDOGE', 'rDOGE']) {
            assert.strictEqual(outputFloorOf(fakeSdk(coin, 100000), {}), 1000000, coin);
        }
    });

    it('uses the network dust threshold on a coin with no soft floor', function () {
        assert.strictEqual(outputFloorOf(fakeSdk('BTC', 546), {}), 546);
        assert.strictEqual(outputFloorOf(fakeSdk('LTC', 5460), {}), 5460);
    });

    it('prefers a quoted floor over the soft floor', function () {
        assert.strictEqual(outputFloorOf(fakeSdk('DOGE', 100000), { quote: { outputFloor: 2000000 } }), 2000000);
    });

    it('matches the encoder soft dust floors', function () {
        const floors = encoderSoftFloors();
        if (!floors) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') assert.fail(`encoder checkout missing at ${ENCODER_DIR}`);
            this.skip();
        }
        assert(Object.keys(floors).length > 0, 'parsed no encoder soft dust floors');
        assert.deepStrictEqual({ ...SOFT_DUST_FLOOR_BY_COIN }, floors);
    });
});
