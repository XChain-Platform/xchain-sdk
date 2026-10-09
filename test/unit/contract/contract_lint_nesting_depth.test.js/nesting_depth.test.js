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
 * test/unit/contract/contract_lint_nesting_depth.test.js/nesting_depth.test.js
 *
 * Nesting-depth verdicts from the SDK's vendored lint core.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    CONSENSUS_RULES,
    lintSource,
    findNestingDepth,
    MAX_NESTING_DEPTH
} = require('../../../../src/contract/lint-core.js');

function parenthesized(depth) {
    return 'module.exports = ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + ';';
}

function depthErrors(code, opts) {
    return lintSource(code, opts).errors.filter((error) => error.rule === 'nesting-depth');
}

describe('vendored lint core: nesting-depth rule', function () {
    it('freezes the rule and limit as consensus parameters', function () {
        assert.ok(CONSENSUS_RULES.has('nesting-depth'));
        assert.strictEqual(MAX_NESTING_DEPTH, 64);
    });

    it('accepts the limit and rejects the first token beyond it', function () {
        assert.deepStrictEqual(findNestingDepth(parenthesized(64)), []);
        assert.deepStrictEqual(findNestingDepth(parenthesized(65)), [{ line: 1, depth: 65 }]);
    });

    it('reports the line of the first excessive opening token', function () {
        const source = 'module.exports =\n' + '('.repeat(64) + '\n(1)' + ')'.repeat(64) + ';';
        assert.deepStrictEqual(findNestingDepth(source), [{ line: 3, depth: 65 }]);
        assert.strictEqual(depthErrors(source)[0].line, 3);
    });

    it('counts mixed delimiters and template substitutions', function () {
        const openings = Array.from({ length: 17 }, () => '([{`x${').join('');
        const closings = Array.from({ length: 17 }, () => '}' + '`' + '}])').join('');
        const source = 'module.exports = ' + openings + '1' + closings + ';';
        assert.deepStrictEqual(findNestingDepth(source), [{ line: 1, depth: 65 }]);
    });

    it('ignores delimiter text in lexical text', function () {
        const source = [
            'var a = "(((([[[{{{";',
            'var b = /[(){}\\[\\]]+/;',
            'var c = `((([[{{ plain text`;',
            '// ((( [[[ {{{',
            'module.exports = a + b.source + c;'
        ].join('\n');
        assert.deepStrictEqual(findNestingDepth(source), []);
        assert.deepStrictEqual(depthErrors(source), []);
    });

    it('rejects extreme input before the AST parser', function () {
        const source = parenthesized(100000);
        assert.doesNotThrow(() => lintSource(source));
        assert.strictEqual(lintSource(source).errors[0].rule, 'nesting-depth');
    });

    it('leaves lexical and parse failures to the existing syntax rules', function () {
        assert.deepStrictEqual(findNestingDepth('function f( {'), []);
        assert.strictEqual(lintSource('function f( {').errors[0].rule, 'unsupported-syntax');
    });

    it('is enabled by default and can be disabled for replay', function () {
        const source = parenthesized(65);
        assert.strictEqual(depthErrors(source).length, 1);
        assert.deepStrictEqual(depthErrors(source, { enforceLintNestingDepth: false }), []);
    });
});
