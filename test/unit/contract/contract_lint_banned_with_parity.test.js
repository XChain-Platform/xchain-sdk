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
 * Direct-scanner and composed-result parity for banned-with.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource, findBannedWith } = require('../../../src/contract/lint-core.js');

const cases = [
    'with (scope) { value; }',
    'function f(scope) {\nwith (scope) { return value; }\n}',
    'with (outer) {\n  with (inner) { value; }\n}',
    'var without = "with"; object.with;',
    'with ('
];

describe('vendored deploy-lint: banned-with result parity', function () {
    for (const source of cases) {
        it('composes the direct scanner findings for ' + JSON.stringify(source), function () {
            const directLines = findBannedWith(source).map((hit) => hit.line);
            const resultLines = lintSource(source).errors
                .filter((error) => error.rule === 'banned-with')
                .map((error) => error.line);

            assert.deepStrictEqual(resultLines, directLines);
        });
    }
});
