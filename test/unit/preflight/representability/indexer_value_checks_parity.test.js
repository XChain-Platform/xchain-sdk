'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const numeric = require('../../../../src/preflight/numeric.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const SDK_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH || process.env.XCHAIN_INDEXER_DIR
    || path.resolve(SDK_ROOT, '..', 'xchain-indexer');
const VALUE_CHECKS = path.join(INDEXER_ROOT, 'src', 'utility', 'validation', 'value_checks.js');
const sdkRequire = Module.createRequire(path.join(SDK_ROOT, 'package.json'));

function loadValueChecks(filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const mod = { exports: {} };
    const wrapper = vm.runInThisContext(Module.wrap(source), { filename });
    const localRequire = (id) => {
        if (id !== 'mathjs') throw new Error(`unexpected value_checks dependency: ${id}`);
        return sdkRequire(id);
    };
    wrapper(mod.exports, localRequire, mod, filename, path.dirname(filename));
    return mod.exports;
}

function boundaryInputs(max) {
    const next = (BigInt(max) + 1n).toString();
    return ['0', '-0', '+0', '-1', max, next, '+' + max, '  ' + next + ' ',
        max + '.0', max + '.4', max + '.49', max + '.5', max + '.51', max + '.6', max + '.9',
        next + '.0', '1e5', '1e19', '1e30', '-1e3', '-0.5', '0x10', '0b1', '0o7',
        '', ' ', 'abc', 'NaN', 'Infinity', null, undefined];
}

function disagreements(indexer) {
    const out = [];
    for (const max of ['18446744073709551615', '4294967295']) {
        for (const value of boundaryInputs(max)) {
            const expected = indexer.exceedsUnsignedColumn(value, max);
            const actual = numeric.exceedsUnsignedColumn(value, max);
            if (actual !== expected) out.push(`${String(value)} @ ${max}: SDK ${actual}, indexer ${expected}`);
        }
    }
    return out;
}

describe('pre-flight numeric storage parity with xchain-indexer value_checks.js', function () {
    let indexer = null;

    before(function () {
        const verdict = siblingCheckout(__dirname, VALUE_CHECKS);
        if (!skipOrFail(this, verdict, 'the value_checks parity guard')) return;
        indexer = loadValueChecks(verdict.path);
    });

    it('matches exceedsUnsignedColumn across integer, fractional, exponent and radix spellings', function () {
        assert.deepStrictEqual(disagreements(indexer), []);
    });

    it('matches keepsPrefixedSpelling across radix, sign, case, whitespace and range spellings', function () {
        const corpus = ['0x10', '0X10', '0b101', '0B101', '0o17', '0O17', ' 0x10 ', '0x0', '-0x10', '+0x10',
            '0x', '0b2', '0o8', '0xg', '0xffffffff', '0x100000000', '0xffffffffffffffff', '0x10000000000000000',
            '0b' + '1'.repeat(64), '0b1' + '0'.repeat(64), '16', '1e12', '+100', '00100', '', null, undefined];
        const out = [];
        for (const max of ['18446744073709551615', '4294967295']) {
            for (const value of corpus) {
                const expected = indexer.keepsPrefixedSpelling(value, max);
                const actual = numeric.keepsPrefixedSpelling(value, max);
                if (actual !== expected) out.push(`${String(value)} @ ${max}: SDK ${actual}, indexer ${expected}`);
            }
        }
        assert.deepStrictEqual(out, []);
    });

    it('pins the storesAsNull width and radix-prefix refusals mirrored by pre-flight', function () {
        const authority = Object.assign({}, indexer);
        assert.strictEqual(authority.storesAsNull('0'.repeat(250), null), false);
        assert.strictEqual(authority.storesAsNull('0'.repeat(251), null), true);
        for (const value of ['0x10', '0X10', '0b1', '0o7', '+0x10', '-0x10'])
            assert.strictEqual(authority.storesAsNull(value, '18446744073709551615'), true, value);
        assert.strictEqual(authority.storesAsNull('16', '18446744073709551615'), false);
    });
});
