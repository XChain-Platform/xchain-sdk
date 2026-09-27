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
 * test/unit/contract/contract_lint_optional_chain.test.js
 *
 * Optional-chain verdicts from the SDK's vendored lint core.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource } = require('../../../src/contract/lint_core.js');

const cases = [
    {
        source: 'const p = (globalThis?.globalThis).Promise;',
        activeRules: ['banned-async'],
        aliasOffRules: []
    },
    {
        source: 'const w = (globalThis?.globalThis).WebAssembly;',
        activeRules: ['banned-wasm'],
        aliasOffRules: []
    },
    {
        source: 'const m = (globalThis?.globalThis).Math.pow(2, 3);',
        activeRules: ['banned-math'],
        aliasOffRules: []
    },
    {
        source: 'const p = (this?.globalThis).Promise;',
        activeRules: ['banned-async'],
        aliasOffRules: []
    },
    {
        source: 'const w = (this?.globalThis)?.WebAssembly;',
        activeRules: ['banned-wasm'],
        aliasOffRules: []
    },
    {
        source: 'const m = (this?.globalThis)?.Math.log(2);',
        activeRules: ['banned-math'],
        aliasOffRules: []
    },
    {
        source: 'const p = (globalThis?.["globalThis"]).Promise;',
        activeRules: ['banned-async'],
        aliasOffRules: []
    },
    {
        source: 'const m = (globalThis?.Math).pow(2, 3);',
        activeRules: ['banned-math'],
        aliasOffRules: ['banned-math']
    },
    {
        source: 'const m = (globalThis?.["Math"]).pow(2, 3);',
        activeRules: ['banned-math'],
        aliasOffRules: ['banned-math']
    },
    {
        source: 'const m = (this?.Math).log(2);',
        activeRules: ['banned-math'],
        aliasOffRules: []
    },
    {
        source: 'const p = ((globalThis?.globalThis)?.globalThis).Promise;',
        activeRules: ['banned-async'],
        aliasOffRules: []
    },
    {
        source: 'const x = (a?.globalThis).Promise;',
        activeRules: [],
        aliasOffRules: []
    },
    {
        source: 'const o = { Math: 1 }; const y = (o?.Math);',
        activeRules: [],
        aliasOffRules: []
    }
];

// W3L-10 removes this skip after re-vendoring the matching lint core.
describe.skip('vendored lint core: optional-chain rules', function () {

    for (const { source, activeRules, aliasOffRules } of cases) {
        it('applies the active rules for ' + source, function () {
            assert.deepStrictEqual(lintSource(source).errors.map((e) => e.rule), activeRules);
        });

        it('applies the alias-off rules for ' + source, function () {
            const result = lintSource(source, { globalAlias: false });
            assert.deepStrictEqual(result.errors.map((e) => e.rule), aliasOffRules);
        });
    }

});
