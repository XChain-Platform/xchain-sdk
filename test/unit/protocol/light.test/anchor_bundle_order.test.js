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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { parseAnchorV0 } = require('../../../../src/protocol/light_client/anchored_checkpoint.js');

function makeSection(chain, pubkeys) {
    const fields = [
        chain, 123, '01'.repeat(32), '02'.repeat(32), '03'.repeat(32), '04'.repeat(32),
        7, 70000000, '05'.repeat(32), 1, '06'.repeat(32), 1, pubkeys.length
    ];
    for (const pubkey of pubkeys) fields.push(pubkey, '07'.repeat(64));
    return fields;
}

function makeWire(network, sections) {
    return [
        0, network, 70000000, sections.length,
        ...sections.flat(),
        '08'.repeat(32), 1, '09'.repeat(32), '0a'.repeat(64)
    ].join('|');
}

function assertParsesWithoutAndWithHeight(wire) {
    assert.doesNotThrow(() => parseAnchorV0(wire));
    assert.doesNotThrow(() => parseAnchorV0(wire, { blockIndex: 70000000 }));
}

describe('ANCHOR bundle ordering before enforcement', function () {
    it('accepts sections that are not CHAIN-ascending', function () {
        const wire = makeWire('testnet', [
            makeSection('DOGE', ['aa', 'bb']),
            makeSection('BTC', ['aa', 'bb'])
        ]);
        assertParsesWithoutAndWithHeight(wire);
    });

    it('accepts section signature pairs that are not PUBKEY-ascending', function () {
        const wire = makeWire('testnet', [
            makeSection('BTC', ['bb', 'aa']),
            makeSection('DOGE', ['aa', 'bb'])
        ]);
        assertParsesWithoutAndWithHeight(wire);
    });
});

describe('ANCHOR bundle canonical ordering', function () {
    function sortedWire(network) {
        return makeWire(network, [
            makeSection('BTC', ['aa', 'bb']),
            makeSection('DOGE', ['aa', 'bb'])
        ]);
    }

    for (const network of ['mainnet', 'testnet']) {
        it('accepts sorted ' + network + ' wires with and without a height', function () {
            assertParsesWithoutAndWithHeight(sortedWire(network));
        });
    }

    it('accepts a sorted regtest wire without a height', function () {
        assert.doesNotThrow(() => parseAnchorV0(sortedWire('regtest')));
    });
});
