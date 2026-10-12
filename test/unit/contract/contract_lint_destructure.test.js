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
 * Destructured global reads through the SDK's vendored lint core.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource,
    findBannedAsync,
    findBannedWasm,
    findBannedMathCalls
} = require('../../../src/contract/lint-core.js');

const cases = [
    ['const { Promise: LocalPromise } = globalThis;', ['banned-async']],
    ['const { Promise: { resolve } } = globalThis;', ['banned-async']],
    ['({ Promise: localPromise } = globalThis);', ['banned-async']],
    ['const { WebAssembly: Wasm } = globalThis;', ['banned-wasm']],
    ['const { WebAssembly: { compile } } = globalThis;', ['banned-wasm']],
    ["const { ['WebAssembly']: Wasm } = globalThis;", ['banned-wasm']],
    ['const { pow: deterministicPow } = Math;', ['banned-math']],
    ['const { pow: { call } } = Math;', ['banned-math']],
    ['({ log: deterministicLog } = globalThis.Math);', ['banned-math']],
    ['const { Math: { sqrt: deterministicSqrt } } = globalThis;', ['banned-math']],
    ['const { Math: { pow: { call } } } = globalThis;', ['banned-math']],
    ['const { random: deterministicRandom } = Math;', ['banned-math']],
    ['const { globalThis: { WebAssembly: Wasm } } = globalThis;', ['banned-wasm'], []],
    ['const { Promise: LocalPromise } = (globalThis?.globalThis);', ['banned-async'], []],
    ['const { floor: deterministicFloor } = Math;', []],
    ['const { Promise: LocalPromise, Math: { pow: localPow } } = other;', []],
    ["const key = 'pow'; const { [key]: localPow } = Math;", []],
    ['const { Promise: LocalPromise, WebAssembly: Wasm, Math: { pow: deterministicPow } } = globalThis;',
        ['banned-math', 'banned-async', 'banned-wasm']]
];

const sourceRules = (source, opts) => lintSource(source, opts).errors.map((finding) => finding.rule);

describe('vendored lint core: ObjectPattern refinement', function () {
    for (const [source, activeRules, aliasOffRules] of cases) {
        it('applies active and legacy verdicts for: ' + source, function () {
            assert.deepStrictEqual(sourceRules(source), activeRules);
            assert.deepStrictEqual(sourceRules(source, { destructure: false }), []);
            if (aliasOffRules)
                assert.deepStrictEqual(sourceRules(source, { globalAlias: false }), aliasOffRules);
        });
    }
});

describe('vendored lint core: ObjectPattern scanner hits', function () {
    const scannerCases = [
        [findBannedAsync, 'const { Promise: LocalPromise } = globalThis;', [{ kind: 'promise', line: 1 }]],
        [findBannedAsync, 'const { Promise: { resolve } } = globalThis;', [{ kind: 'promise', line: 1 }]],
        [findBannedWasm, 'const { WebAssembly: Wasm } = globalThis;', [{ line: 1 }]],
        [findBannedWasm, 'const { WebAssembly: { compile } } = globalThis;', [{ line: 1 }]],
        [findBannedMathCalls, 'const { pow: deterministicPow } = Math;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedMathCalls, 'const { pow: { call } } = Math;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedMathCalls, 'const { Math: { pow: { call } } } = globalThis;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedAsync, '({ Promise: localPromise } = globalThis);', [{ kind: 'promise', line: 1 }]],
        [findBannedWasm, '({ WebAssembly: wasm } = globalThis);', [{ line: 1 }]],
        [findBannedMathCalls, '({ log: deterministicLog } = globalThis.Math);',
            [{ name: 'log', line: 1, transcendental: true }]]
    ];
    for (const [scan, source, expected] of scannerCases) {
        it('reports the static property read in ' + source, function () {
            assert.deepStrictEqual(scan(source), expected);
        });
    }
});

describe('vendored lint core: ObjectPattern flag composition', function () {
    it('keeps each scanner byte-for-byte legacy when destructure is false', function () {
        assert.deepStrictEqual(findBannedAsync(
            'const { Promise: LocalPromise } = globalThis;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedWasm(
            'const { WebAssembly: Wasm } = globalThis;', true, true, false), []);
        assert.deepStrictEqual(findBannedMathCalls(
            'const { pow: deterministicPow } = Math;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedAsync(
            'const { Promise: { resolve } } = globalThis;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedWasm(
            'const { WebAssembly: { compile } } = globalThis;', true, true, false), []);
        assert.deepStrictEqual(findBannedMathCalls(
            'const { pow: { call } } = Math;', true, true, true, false), []);
    });

    it('does not treat safe, dynamic, or unrelated properties as banned reads', function () {
        const clean = [
            'const { floor: deterministicFloor } = Math;',
            'const { floor: { call } } = Math;',
            'const key = "pow"; const { [key]: localPow } = Math;',
            'const key = "Math"; const { [key]: { pow: localPow } } = globalThis;',
            'const { pow: localPow } = other;',
            'const { safe: { Promise: LocalPromise } } = globalThis;',
            'const { Promise: LocalPromise, WebAssembly: Wasm } = other;'
        ];
        for (const source of clean)
            assert.deepStrictEqual(sourceRules(source), [], 'unexpected finding for: ' + source);
    });

    it('composes aliases and optional chains only under their own flags', function () {
        const alias = 'const { globalThis: { Promise: LocalPromise } } = globalThis;';
        assert.deepStrictEqual(sourceRules(alias), ['banned-async']);
        assert.deepStrictEqual(sourceRules(alias, { globalAlias: false }), []);
        const optional = 'const { Math: { pow: deterministicPow } } = (globalThis?.globalThis);';
        assert.deepStrictEqual(sourceRules(optional), ['banned-math']);
        assert.deepStrictEqual(sourceRules(optional, { optionalChain: false }), []);
    });
});
