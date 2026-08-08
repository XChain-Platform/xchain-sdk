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
const Utility = require('../../src/utility.js');

describe('BigInt JSON encoding (#3921)', function () {

    it('stringifies a BigInt as a QUOTED decimal token', function () {
        // JSON.rawJSON emitted a bare number, which JSON.parse then rounded.
        assert.strictEqual(JSON.stringify({ v: 9007199254740993n }), '{"v":"9007199254740993"}');
    });

    it('survives a stringify/parse round trip above 2^53 with no koinu lost', function () {
        const v = 12000000000000000000n;
        const back = JSON.parse(JSON.stringify({ v }));
        assert.strictEqual(typeof back.v, 'string');
        assert.strictEqual(BigInt(back.v), v);
    });

    it('is exact at the first value Number cannot represent', function () {
        const back = JSON.parse(JSON.stringify({ v: 9007199254740993n }));
        assert.strictEqual(BigInt(back.v), 9007199254740993n);
    });
});

describe('Utility.isValidAmountFormat (indexer parity)', function () {

    let utils;

    beforeEach(function () {
        utils = new Utility();
    });

    it('rejects negative amounts (parity with indexer consensus guard)', function () {
        // The exact drift input: without the negative guard this returned true.
        assert.strictEqual(utils.isValidAmountFormat(8, '-1.5'), false);
        assert.strictEqual(utils.isValidAmountFormat(8, '-100'), false);
        assert.strictEqual(utils.isValidAmountFormat(0, '-1'), false);
        assert.strictEqual(utils.isValidAmountFormat(8, '-0.00000001'), false);
    });

    it('rejects unsafe object amounts', function () {
        const unsafe = Object.create(null); // no toString
        assert.strictEqual(utils.isValidAmountFormat(8, unsafe), false);
    });

    it('still accepts valid positive amounts', function () {
        assert.strictEqual(utils.isValidAmountFormat(8, '1.5'), true);
        assert.strictEqual(utils.isValidAmountFormat(0, '100'), true);
        assert.strictEqual(utils.isValidAmountFormat(8, '0'), true);
    });

    it('still rejects over-precise amounts (fractional cap intact)', function () {
        assert.strictEqual(utils.isValidAmountFormat(2, '1.123'), false);
    });
});

describe('Utility.isInteger (indexer parity, #2393)', function () {

    let utils;

    beforeEach(function () {
        utils = new Utility();
    });

    it('accepts plain and numeric-string integers, including past int32 range', function () {
        assert.strictEqual(utils.isInteger(5), true);
        assert.strictEqual(utils.isInteger('5'), true);
        assert.strictEqual(utils.isInteger(2147483648), true);  // int32 max + 1
        assert.strictEqual(utils.isInteger(3000000000), true);  // beyond int32 range
        assert.strictEqual(utils.isInteger(4294967295), true);  // uint32 max
    });

    it('rejects non-integers, non-numeric strings, NaN and Infinity', function () {
        assert.strictEqual(utils.isInteger(5.5), false);
        assert.strictEqual(utils.isInteger('5.5'), false);
        assert.strictEqual(utils.isInteger('abc'), false);
        assert.strictEqual(utils.isInteger(NaN), false);
        assert.strictEqual(utils.isInteger(Infinity), false);
    });
});

// : the version-locked helpers built `{ VERSION: '3', ...params }`, so the
// spread landed after the forced value and a caller-supplied VERSION won. Lowercase
// `version` won too, since normalizeFields upper-snakes both spellings onto one key.
// The consequence was a silent misroute: stakeToContract({ VERSION: '1' }) serialized
// STAKE|1 and dropped TARGET_CONTRACT_INDEX and TICK.
describe('Utility.withForcedVersion (version-locked helpers)', function () {

    let utils;

    beforeEach(function () {
        utils = new Utility();
    });

    it('forces its version over a caller VERSION in either spelling', function () {
        assert.strictEqual(utils.withForcedVersion('3', { AMOUNT: '5' }).VERSION, '3');
        assert.strictEqual(utils.withForcedVersion('3', {}).VERSION, '3');
        assert.strictEqual(utils.withForcedVersion('3', { VERSION: '3', AMOUNT: '5' }).VERSION, '3');
        assert.strictEqual(utils.withForcedVersion('3', { version: 3 }).VERSION, '3');
    });

    it('throws rather than route a MISMATCHED caller version', function () {
        assert.throws(() => utils.withForcedVersion('3', { VERSION: '1' }), /forces VERSION 3/);
        assert.throws(() => utils.withForcedVersion('3', { version: '1' }), /forces VERSION 3/);
        assert.throws(() => utils.withForcedVersion('1', { Version: 4 }), /forces VERSION 1/);
    });

    it('carries every other param through untouched', function () {
        let out = utils.withForcedVersion('3', { AMOUNT: '5', TARGET_CONTRACT_INDEX: 7, TICK: 'AAA' });
        assert.strictEqual(out.AMOUNT, '5');
        assert.strictEqual(out.TARGET_CONTRACT_INDEX, 7);
        assert.strictEqual(out.TICK, 'AAA');
        assert.strictEqual(Object.keys(out).length, 4);
    });
});
