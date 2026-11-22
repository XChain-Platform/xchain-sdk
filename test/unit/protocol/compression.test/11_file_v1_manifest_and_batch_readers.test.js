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
 * FILE v1 multipart manifests and BATCH-wrapped FILEs: the SDK read-side
 * helpers find COMPRESSION and GATE_TICKER at the version's own positions,
 * and the write side stays FILE v0 only.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const XChainSDK = require('../../../../src/XChainSDK.js');
const CompressionUtils = require('../../../../src/protocol/compression.js');
const { SDKCompressionError } = require('../../../../src/utils/errors.js');

const sdk = new XChainSDK({
    network: 'bitcoin-regtest', explorerUrl: 'http://localhost:8080',
    encoderUrl: 'http://localhost:3000', retry: false,
});

const MANIFEST = {
    version: 1, fileHash: 'ab'.repeat(32), totalParts: 3, totalBytes: 900,
    name: 'a.bin', type: 'application/octet-stream', title: 'T', memo: 'M',
    gateTicker: '', encryptionMethod: '', keyHash: '', gateMinAmount: '', compression: '1',
};
const GATE = { gateTicker: 'MYTOKEN', encryptionMethod: 1, keyHash: 'c'.repeat(64), gateMinAmount: '100' };
const manifest = overrides => sdk.actions.createAction({
    action: 'FILE', params: Object.assign({}, MANIFEST, overrides) }).actionString;

function registerManifestReaderTests(compression) {
    it('reads COMPRESSION from a serializer-built v1 manifest', function () {
        const action = manifest({});
        assert.strictEqual(action.split('|')[13], '1');
        assert.strictEqual(compression.compressionFieldOf(action), '1');
        assert.strictEqual(compression.isCompressedAction(action), true);
    });

    it('reads a v1 manifest with no COMPRESSION as raw', function () {
        const action = manifest({ compression: '' });
        assert.strictEqual(compression.compressionFieldOf(action), '');
        assert.strictEqual(compression.isCompressedAction(action), false);
        assert.strictEqual(compression.isGatedAction(action), false);
    });

    it('reads an unknown v1 COMPRESSION code as raw while keeping the field readable', function () {
        const action = manifest({ compression: '2' });
        assert.strictEqual(compression.isCompressedAction(action), false);
        assert.strictEqual(compression.compressionFieldOf(action), '2');
    });

    it('reads a gated compressed v1 manifest as both gated and compressed', function () {
        const action = manifest(GATE);
        assert.strictEqual(action.split('|')[9], 'MYTOKEN');
        assert.strictEqual(compression.isGatedAction(action), true);
        assert.strictEqual(compression.isCompressedAction(action), true);
    });

    it('does not read a v0 position out of a v1 manifest', function () {
        const action = manifest({ compression: '' });
        assert.strictEqual(action.split('|')[6], 'application/octet-stream');
        assert.strictEqual(compression.isGatedAction(action), false);
        assert.strictEqual(compression.compressionFieldOf(action), '');
    });
}

function registerBatchAndWriterTests(compression) {
    it('reads a FILE inside a BATCH, for v0 and v1', function () {
        const v0 = 'FILE|0|a.txt|text/plain|T|M|MYTOKEN|1|' + 'a'.repeat(64) + '|100|1';
        for (const file of [v0, manifest(GATE)]) {
            const batch = 'BATCH|0|SEND|0|XCHAIN|1|dest;' + file;
            assert.strictEqual(compression.isCompressedAction(batch), true, file);
            assert.strictEqual(compression.isGatedAction(batch), true, file);
        }
    });

    it('reads a BATCH with no FILE inside as raw and ungated', function () {
        const batch = 'BATCH|0|SEND|0|XCHAIN|1|dest;SEND|0|XCHAIN|2|dest|||||||1';
        assert.strictEqual(compression.isCompressedAction(batch), false);
        assert.strictEqual(compression.isGatedAction(batch), false);
        assert.strictEqual(compression.compressionFieldOf(batch), '');
    });

    it('still refuses an unknown FILE version', function () {
        const action = 'FILE|2|' + manifest({}).split('|').slice(2).join('|');
        assert.strictEqual(compression.isCompressedAction(action), false);
        assert.strictEqual(compression.isGatedAction(action), false);
    });

    it('keeps withCompressionField v0-only', function () {
        for (const action of [manifest({}), 'BATCH|0|' + manifest({})]) {
            assert.throws(() => compression.withCompressionField(action, '1'),
                err => err instanceof SDKCompressionError && err.code === 'NOT_A_FILE_ACTION');
        }
    });
}

describe('CompressionUtils: FILE v1 manifest and BATCH-wrapped FILE readers', function () {
    const compression = new CompressionUtils();
    registerManifestReaderTests(compression);
    registerBatchAndWriterTests(compression);
});
