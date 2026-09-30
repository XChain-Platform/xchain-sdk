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
 * test/unit/contract/contract_lint_optional_chain_legacy.test.js
 *
 * Pre-activation optional-chain verdicts from the vendored lint core.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource } = require('../../../src/contract/lint_core.js');

const cases = [
    ['const p = globalThis?.Promise;', ['banned-async']],
    ['const p = (globalThis?.globalThis).Promise;', []],
    ['const w = (globalThis?.globalThis).WebAssembly;', []],
    ['const m = (globalThis?.globalThis).Math.pow(2, 3);', []],
    ['const p = (this?.globalThis).Promise;', []],
    ['const w = (this?.globalThis)?.WebAssembly;', []],
    ['const m = (this?.globalThis)?.Math.log(2);', []],
    ['const p = (globalThis?.["globalThis"]).Promise;', []],
    ['const m = (globalThis?.Math).pow(2, 3);', []],
    ['const m = (globalThis?.["Math"]).pow(2, 3);', []],
    ['const m = (this?.Math).log(2);', []],
    ['const p = ((globalThis?.globalThis)?.globalThis).Promise;', []],
    ['const x = (a?.globalThis).Promise;', []],
    ['const o = { Math: 1 }; const y = (o?.Math);', []]
];

describe('vendored lint core: optional-chain legacy verdicts', function () {

    it('holds exactly fourteen cases', function () {
        assert.strictEqual(cases.length, 14);
    });

    for (const [source, expected] of cases) {
        it('preserves the pre-activation verdict for ' + source, function () {
            const optionalChainOff = lintSource(source, { optionalChain: false });
            const allAliasesOff = lintSource(source, {
                optionalChain: false,
                globalAlias: false
            });

            assert.deepStrictEqual(optionalChainOff.errors.map((e) => e.rule), expected);
            assert.deepStrictEqual(allAliasesOff.errors.map((e) => e.rule), expected);
        });
    }

});
