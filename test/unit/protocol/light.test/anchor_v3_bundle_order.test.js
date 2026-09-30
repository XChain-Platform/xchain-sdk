/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { parseAnchorV3 } = require('../../../../src/protocol/light_client.js');

function makeSection(chain, char) {
    const hash = char.repeat(64);
    return [
        chain, 123, hash, hash, hash, hash,
        7, 70000000, hash, 1, hash, 1, 1, char.repeat(64), char.repeat(128)
    ];
}

function makeWire(network, chains) {
    return [
        3, network, 70000000, chains.length,
        ...chains.flatMap((chain, index) => makeSection(chain, index ? 'b' : 'a')),
        0, 0, 0
    ].join('|');
}

describe('ANCHOR v3 bundle ordering', function () {
    it('preserves ungated parsing for an omitted height and testnet', function () {
        const wire = makeWire('testnet', ['DOGE', 'BTC']);
        assert.doesNotThrow(() => parseAnchorV3(wire));
        assert.doesNotThrow(() => parseAnchorV3(wire, { blockIndex: 0 }));
    });

    it('refuses descending chain order on active regtest', function () {
        const wire = makeWire('regtest', ['DOGE', 'BTC']);
        assert.throws(
            () => parseAnchorV3(wire, { blockIndex: 0 }),
            { message: 'LightClient: ANCHOR sections not CHAIN-ascending' }
        );
    });

    it('accepts ascending chain order on active regtest', function () {
        const wire = makeWire('regtest', ['BTC', 'DOGE']);
        assert.doesNotThrow(() => parseAnchorV3(wire, { blockIndex: 0 }));
    });
});
