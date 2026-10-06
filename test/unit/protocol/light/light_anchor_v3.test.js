/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const light = require('../../../src/protocol/light_client.js');

const hash = (char) => char.repeat(64);
const signature = (char) => char.repeat(128);

function section(chain, height, char){
    return [
        chain, height, hash(char), hash(char), hash(char), hash(char), height, 100,
        hash(char), 1, hash(char), 1, 1, hash(char), signature(char)
    ];
}

function v3Wire(archiveCount, wrapperSectionIndex){
    const parts = [
        'ANCHOR', '3', 'regtest', 100, 3,
        ...section('BTC', 10, 'a'),
        ...section('DOGE', 20, 'b'),
        ...section('LTC', 30, 'c'),
        archiveCount
    ];
    if (Number(archiveCount) === 1)
        parts.push(wrapperSectionIndex, 42, 17, '9C4E1B22', 1, 'H4sIAAAAAAAAAw==');
    parts.push(hash('d'), 1, hash('e'), signature('e'));
    return parts.join('|');
}

function v0Wire(){
    return [
        'ANCHOR', '0', 'regtest', 100, 1,
        ...section('BTC', 10, 'a'), hash('d'), 0
    ].join('|');
}

describe('light client ANCHOR v3 parser', function () {
    it('parses chain sections and binds the archive through WRAPPER_SECTION_INDEX', function () {
        const parsed = light.parseAnchorV3(v3Wire(1, 2));
        assert.strictEqual(parsed.version, 3);
        assert.strictEqual(parsed.network, 'regtest');
        assert.deepStrictEqual(parsed.sections.map((item) => item.chain), ['BTC', 'DOGE', 'LTC']);
        assert.strictEqual(parsed.archive_count, 1);
        assert.strictEqual(parsed.archive.wrapper_section_index, 2);
        assert.strictEqual(parsed.sections[parsed.archive.wrapper_section_index].chain, 'LTC');
        assert.strictEqual(parsed.archive.match_batch_seq, 42);
        assert.strictEqual(parsed.archive.match_count, 17);
        assert.strictEqual(parsed.archive.batch_crc32, '9c4e1b22');
        assert.strictEqual(parsed.archive.total_chunks, 1);
        assert.strictEqual(parsed.publisher_attestations.length, 1);
        assert.strictEqual(light.anchorBundleSection(v3Wire(1, 2), 'doge').block_index, 20);
    });

    it('parses ARCHIVE_COUNT 0 without consuming archive fields', function () {
        const parsed = light.parseAnchorV3(v3Wire(0));
        assert.strictEqual(parsed.archive_count, 0);
        assert.strictEqual(parsed.archive, null);
        assert.strictEqual(parsed.publisher, hash('d'));
        assert.strictEqual(parsed.publisher_attestations.length, 1);
    });

    it('refuses ARCHIVE_COUNT above 1 with the protocol error', function () {
        assert.throws(() => light.parseAnchorV3(v3Wire(2)), /invalid: ARCHIVE_COUNT/);
    });

    it('refuses a wrapper index outside the parsed section list', function () {
        assert.throws(() => light.parseAnchorV3(v3Wire(1, 3)), /invalid: WRAPPER_SECTION_INDEX/);
    });

    it('leaves the shipped v0 parser and version boundary unchanged', function () {
        const wire = v0Wire();
        const parsed = light.parseAnchorV0(wire);
        assert.strictEqual(parsed.version, 0);
        assert.strictEqual(parsed.sections[0].chain, 'BTC');
        assert.strictEqual(light.anchorBundleSection(wire, 'BTC').block_index, 10);
        assert.throws(() => light.parseAnchorV0(v3Wire(0)), /not an ANCHOR bundle/);
        for (const version of [0, 1, 2])
            assert.throws(() => light.parseAnchorV3(String(version) + '|x'), /not an ANCHOR v3 bundle/);
    });
});
