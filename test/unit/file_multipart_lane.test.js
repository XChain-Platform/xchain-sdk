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
const {
    multipartLaneFor,
    twoStepEnvelopeOptions
} = require('../../src/file/multipart_lane.js');

const SOURCE_TYPES = [
    'p2pkh',
    'p2wpkh',
    'p2sh-p2wpkh',
    'p2sh',
    'p2wsh',
    undefined,
    'p2tr'
];

function expectedLane(taprootChain, sourceType) {
    if (taprootChain && (sourceType === 'p2wpkh' || sourceType === 'p2tr')) {
        return { lane: 'envelope', buildMode: 'one_call' };
    }
    if (taprootChain && (sourceType === 'p2pkh' || sourceType === 'p2sh-p2wpkh')) {
        return { lane: 'envelope', buildMode: 'two_step' };
    }
    if (!taprootChain && ['p2pkh', 'p2wpkh', 'p2sh-p2wpkh'].includes(sourceType)) {
        return { lane: 'standard', buildMode: 'one_call' };
    }
    return null;
}

function assertUnsupported(run, sourceType) {
    assert.throws(run, (error) => {
        assert(error instanceof Error);
        assert.strictEqual(error.code, 'MULTIPART_SOURCE_UNSUPPORTED');
        assert.match(error.message, new RegExp(String(sourceType).replace('-', '\\-')));
        return true;
    });
}

describe('multipart lane selection', function () {
    for (const taprootChain of [true, false]) {
        for (const sourceType of SOURCE_TYPES) {
            const chainKind = taprootChain ? 'Taproot' : 'non-Taproot';
            const typeName = String(sourceType);
            it(chainKind + ' with ' + typeName, function () {
                const expected = expectedLane(taprootChain, sourceType);
                const run = () => multipartLaneFor({ taprootChain, sourceType });
                if (expected) {
                    assert.deepStrictEqual(run(), expected);
                } else {
                    assertUnsupported(run, sourceType);
                }
            });
        }
    }

    it('refuses every non-boolean taprootChain value with the source type named', function () {
        for (const taprootChain of [undefined, null, 0, 1, 'true', {}, []]) {
            assertUnsupported(
                () => multipartLaneFor({ taprootChain, sourceType: 'p2wpkh' }),
                'p2wpkh'
            );
        }
    });

    it('refuses a missing argument as an unsupported undefined source type', function () {
        assertUnsupported(() => multipartLaneFor(), undefined);
    });
});

describe('two-step envelope options', function () {
    it('returns the exact commit option shape', function () {
        assert.deepStrictEqual(twoStepEnvelopeOptions('commit'), {
            exactInputs: true,
            twoStepEnvelope: true
        });
    });

    it('returns the exact reveal option shape', function () {
        assert.deepStrictEqual(twoStepEnvelopeOptions('reveal', '00aAFF'), {
            envelopeCommitHex: '00aAFF'
        });
    });

    it('never carries commit-only options on a reveal', function () {
        const options = twoStepEnvelopeOptions('reveal', 'deadbeef');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(options, 'exactInputs'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(options, 'twoStepEnvelope'), false);
    });

    it('refuses every unknown phase and names it', function () {
        for (const phase of [undefined, null, '', 'funding', 'COMMIT']) {
            assert.throws(
                () => twoStepEnvelopeOptions(phase, '00'),
                (error) => error instanceof Error && error.message.includes(String(phase))
            );
        }
    });

    it('refuses missing, empty, odd-length, and non-hex reveal commit values', function () {
        for (const signedCommitHex of [undefined, null, '', '0', 'abc', '0g', '00 11', 12]) {
            assert.throws(
                () => twoStepEnvelopeOptions('reveal', signedCommitHex),
                (error) => error instanceof Error && error.message.includes('signedCommitHex')
            );
        }
    });
});
