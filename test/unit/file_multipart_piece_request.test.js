// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { pieceCreateTxParams } = require('../../src/file/multipart_piece_request.js');

function fixture(overrides = {}) {
    return Object.assign({
        lane: 'envelope',
        pubkey: '02' + '11'.repeat(32),
        sourceAddress: 'source-address',
        utxo: {
            txid: 'ab'.repeat(32),
            vout: 2,
            value: 500000,
            scriptPubKey: '0014' + '22'.repeat(20),
        },
        rate: 1,
        data: 'FILE|2|hash|0',
        rawData: Buffer.from('piece bytes'),
        p2shHash: 'cd'.repeat(32),
        commitHex: '020000000001',
    }, overrides);
}

function sortedKeys(value) {
    return Object.keys(value).sort();
}

function assertNoUndefined(value) {
    for (const [key, entry] of Object.entries(value))
        assert.notStrictEqual(entry, undefined, key + ' must not be undefined');
}

describe('piece request shapes', function () {
    it('builds the envelope request with its exact key set', function () {
        const args = fixture({ rate: 12.5 });
        const request = pieceCreateTxParams(args);
        assert.deepStrictEqual(sortedKeys(request), [
            'change', 'compress', 'data', 'encoding', 'feePerKb', 'options',
            'pubkey', 'rawData', 'sourceAddress', 'utxos',
        ]);
        assert.strictEqual(request.encoding, 'TAPROOT');
        assert.deepStrictEqual(request.utxos, [args.utxo]);
        assert.deepStrictEqual(request.options, { exactInputs: true });
        assert.strictEqual(request.sourceAddress, args.sourceAddress);
        assert.strictEqual(request.change, args.sourceAddress);
        assert.strictEqual(request.compress, false);
        assert.strictEqual(request.feePerKb, 12500);
        assert.strictEqual(request.data, args.data);
        assert.strictEqual(request.rawData, args.rawData);
        assert.ok(!Object.hasOwn(request, 'unconfirmed'));
        assertNoUndefined(request);
    });

    it('builds the standard commit request with its exact key set', function () {
        const args = fixture({ lane: 'standard', phase: 'commit', rate: 1 });
        const request = pieceCreateTxParams(args);
        assert.deepStrictEqual(sortedKeys(request), [
            'change', 'compress', 'data', 'encoding', 'feePerKb', 'options',
            'pubkey', 'rawData', 'sourceAddress', 'utxos',
        ]);
        assert.strictEqual(request.encoding, 'P2SH');
        assert.strictEqual(request.feePerKb, 1000);
        assert.deepStrictEqual(request.utxos, [args.utxo]);
        assert.deepStrictEqual(request.options, { exactInputs: true });
        assert.ok(!Object.hasOwn(request, 'unconfirmed'));
        assertNoUndefined(request);
    });
});

describe('piece reveal shape', function () {
    it('uses phase-2 names and no funding selectors', function () {
        const args = fixture({ lane: 'standard', phase: 'reveal', rate: 12.5 });
        const request = pieceCreateTxParams(args);
        assert.deepStrictEqual(sortedKeys(request), [
            'change', 'compress', 'data', 'encoding', 'feePerKb', 'p2shHash',
            'p2shHex', 'pubkey', 'rawData',
        ]);
        assert.strictEqual(request.encoding, 'P2SH');
        assert.strictEqual(request.p2shHash, args.p2shHash);
        assert.strictEqual(request.p2shHex, args.commitHex);
        assert.strictEqual(request.feePerKb, 12500);
        for (const key of ['utxos', 'sourceAddress', 'options', 'exactInputs', 'unconfirmed'])
            assert.ok(!Object.hasOwn(request, key), key + ' must not ride a reveal');
        assert.ok(!JSON.stringify(request).includes('exactInputs'));
        assertNoUndefined(request);
    });

    it('omits unset pass-through fields', function () {
        const request = pieceCreateTxParams(fixture({
            lane: 'standard', phase: 'reveal', pubkey: undefined,
            sourceAddress: undefined, data: undefined,
        }));
        assertNoUndefined(request);
        assert.ok(!Object.hasOwn(request, 'pubkey'));
        assert.ok(!Object.hasOwn(request, 'change'));
        assert.ok(!Object.hasOwn(request, 'data'));
    });
});

describe('piece request refusals', function () {
    it('refuses an unknown lane and phase', function () {
        assert.throws(() => pieceCreateTxParams(fixture({ lane: 'sidecar' })), /lane/);
        assert.throws(() => pieceCreateTxParams(fixture({ lane: 'standard', phase: 'fund' })), /phase/);
        assert.throws(() => pieceCreateTxParams(fixture({ phase: 'reveal' })), /phase/);
    });

    it('refuses non-finite and non-positive rates', function () {
        for (const rate of [NaN, Infinity, -Infinity, 0, -1])
            assert.throws(() => pieceCreateTxParams(fixture({ rate })), /rate/);
    });

    it('refuses every missing required utxo field', function () {
        for (const field of ['txid', 'vout', 'value', 'scriptPubKey']) {
            const utxo = Object.assign({}, fixture().utxo);
            delete utxo[field];
            assert.throws(() => pieceCreateTxParams(fixture({ utxo })), new RegExp(field));
        }
        assert.throws(() => pieceCreateTxParams(fixture({ utxo: undefined })), /utxo/);
    });

    it('refuses missing rawData', function () {
        assert.throws(() => pieceCreateTxParams(fixture({ rawData: undefined })), /rawData/);
        assert.throws(() => pieceCreateTxParams(fixture({ rawData: null })), /rawData/);
    });

    it('refuses missing reveal identifiers', function () {
        const reveal = { lane: 'standard', phase: 'reveal' };
        assert.throws(() => pieceCreateTxParams(fixture(Object.assign({}, reveal, { p2shHash: '' }))), /p2shHash/);
        assert.throws(() => pieceCreateTxParams(fixture(Object.assign({}, reveal, { commitHex: '' }))), /commitHex/);
    });
});
