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
 * test/unit/contract/contract_lint_nesting_depth.test.js
 *
 * Nesting-depth verdicts from the SDK's vendored lint core.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource,
    findNestingDepthViolation,
    LINT_MAX_NESTING_DEPTH
} = require('../../../src/contract/lint-core.js');

const wrap = (expression) => 'module.exports = function () { return ' + expression + '; };';
const nest = (count, open, close) => open.repeat(count) + '1' + close.repeat(count);
const mixedNest = (count) => {
    const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
    let open = '';
    let close = '';
    for (let i = 0; i < count; i += 1) {
        const pair = pairs[i % pairs.length];
        open += pair[0];
        close = pair[1] + close;
    }
    return open + '1' + close;
};

describe('vendored lint core: nesting-depth rule', function () {
    it('exports the frozen limit', function () {
        assert.strictEqual(LINT_MAX_NESTING_DEPTH, 64);
    });

    it('accepts depth 64 and rejects depth 65', function () {
        const accepted = wrap(nest(64, '(', ')'));
        const rejected = wrap(nest(65, '(', ')'));
        assert.deepStrictEqual(lintSource(accepted).errors, []);

        const lint = lintSource(rejected);
        assert.strictEqual(lint.errors[0].rule, 'nesting-depth');
        assert.strictEqual(lint.errors[0].severity, 'error');
    });

    it('can be disabled on the public path', function () {
        const code = wrap(nest(65, '(', ')'));
        assert.strictEqual(lintSource(code, { enforceLintNestingDepth: false }).errors.length, 0);
    });

    it('rejects extreme input before the AST parser', function () {
        const code = wrap(nest(100000, '(', ')'));
        assert.strictEqual(lintSource(code).errors[0].rule, 'nesting-depth');
    });

    it('counts all delimiter families toward one overall depth', function () {
        assert.strictEqual(findNestingDepthViolation(wrap(mixedNest(64))), null);
        assert.strictEqual(findNestingDepthViolation(wrap(mixedNest(65))).rule, 'nesting-depth');
        assert.strictEqual(findNestingDepthViolation(nest(65, '[', ']')), null);
        assert.strictEqual(findNestingDepthViolation(nest(66, '[', ']')).rule, 'nesting-depth');
        assert.strictEqual(findNestingDepthViolation(nest(65, '{', '}')), null);
        assert.strictEqual(findNestingDepthViolation(nest(66, '{', '}')).rule, 'nesting-depth');
    });

    it('ignores delimiters in lexical text', function () {
        const many = '('.repeat(200);
        const sources = [
            wrap(JSON.stringify(many) + '.length'),
            wrap('`' + many + '`.length'),
            wrap('/[(]+/.test("(")'),
            '/* ' + many + ' */ module.exports = function () { return 1; };'
        ];
        for (const source of sources) {
            assert.strictEqual(findNestingDepthViolation(source), null);
            assert.ok(!lintSource(source).errors.some((error) => error.rule === 'nesting-depth'));
        }
    });
});
