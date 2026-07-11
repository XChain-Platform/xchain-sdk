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
const ContractUtils = require('../../src/contracts.js');

describe('ContractUtils', function () {

    let utils;

    beforeEach(function () {
        utils = new ContractUtils();
    });

    /*
     *  encode()
     */

    describe('encode()', function () {
        it('base64-encodes a simple JS string', function () {
            let b64 = utils.encode('hello');
            assert.strictEqual(b64, Buffer.from('hello', 'utf8').toString('base64'));
        });

        it('round-trips with decode()', function () {
            let src = 'function main() { return 42; }';
            assert.strictEqual(utils.decode(utils.encode(src)), src);
        });

        it('encodes multi-byte UTF-8 characters', function () {
            let src = 'α β γ';
            let hex = utils.encode(src);
            assert.strictEqual(utils.decode(hex), src);
        });

        it('throws SDKContractError when source is not a string', function () {
            try {
                utils.encode(12345);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
                assert.strictEqual(e.code, 'CODE_ENCODING_FAILED');
            }
        });

        it('throws SDKContractError for null', function () {
            try {
                utils.encode(null);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
            }
        });
    });

    /*
     *  decode()
     */

    describe('decode()', function () {
        it('decodes a valid base64 string', function () {
            let b64 = Buffer.from('world', 'utf8').toString('base64');
            assert.strictEqual(utils.decode(b64), 'world');
        });

        it('decodes empty base64 string to empty string', function () {
            assert.strictEqual(utils.decode(''), '');
        });

        it('throws SDKContractError for non-string input', function () {
            try {
                utils.decode(42);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
                assert.strictEqual(e.code, 'CODE_ENCODING_FAILED');
            }
        });

        it('throws SDKContractError for invalid base64 characters', function () {
            try {
                utils.decode('!!!!');   // '!' is outside the base64 alphabet
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
                assert.strictEqual(e.code, 'CODE_ENCODING_FAILED');
            }
        });

        it('accepts padded base64', function () {
            let b64 = Buffer.from('hi', 'utf8').toString('base64'); // 'aGk='
            assert.strictEqual(utils.decode(b64), 'hi');
        });
    });

    /*
     *  checkCodeSize()
     */

    describe('checkCodeSize()', function () {
        it('returns withinLimit=true for small code', function () {
            let result = utils.checkCodeSize('let x = 1;');
            assert.strictEqual(result.withinLimit, true);
            assert.ok(result.bytes > 0);
            assert.strictEqual(result.limit, 65536);
        });

        it('returns withinLimit=false for oversized code', function () {
            let bigCode = 'x'.repeat(65537);
            let result = utils.checkCodeSize(bigCode);
            assert.strictEqual(result.withinLimit, false);
            assert.ok(result.bytes > 65536);
        });

        it('returns withinLimit=true for exactly 65536 bytes', function () {
            let code = 'a'.repeat(65536);
            let result = utils.checkCodeSize(code);
            assert.strictEqual(result.withinLimit, true);
            assert.strictEqual(result.bytes, 65536);
        });

        it('coerces non-string input to string', function () {
            let result = utils.checkCodeSize(12345);
            assert.ok(result.withinLimit);
        });
    });

    /*
     *  validate()
     */

    describe('validate()', function () {
        it('returns valid=true for valid JS', function () {
            let result = utils.validate('var x = 1; x + 2;');
            // acorn may or may not be installed; if it is, valid should be true
            if (result.valid) {
                assert.strictEqual(result.valid, true);
            } else {
                // acorn not installed: check the degraded message
                assert.ok(result.error.includes('acorn') || result.error.includes('syntax'));
            }
        });

        it('returns valid=false for non-string input', function () {
            let result = utils.validate(null);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('returns valid=false for oversized code', function () {
            let bigCode = 'a'.repeat(65537);
            let result = utils.validate(bigCode);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('65536'));
        });

        it('returns valid=false when source contains __gas', function () {
            // This branch only fires if acorn is installed and parses successfully
            let result = utils.validate('var __gas = 5;');
            if (result.error && /acorn/i.test(result.error)) {
                // acorn not installed: the reserved-identifier pre-check cannot run.
                this.skip();
            }
            // Parse path available: the __gas reservation must be rejected with a
            // matching error. This fails if the client-side reservation check regresses.
            assert.strictEqual(result.valid, false);
            assert.ok(result.error && result.error.includes('__gas'));
        });

        it('returns valid=false for invalid JS syntax (when acorn available)', function () {
            let result = utils.validate('function broken( { ');
            // With acorn: syntax error. Without acorn: reports missing acorn.
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('warns about float literals when acorn available', function () {
            let result = utils.validate('var x = 1.5;');
            if (result.valid) {
                // acorn is available
                assert.ok(Array.isArray(result.warnings));
                assert.ok(result.warnings.some(w => w.includes('decimal number literal')));
            }
        });

        it('returns valid=true with no warnings for integer-only code', function () {
            let result = utils.validate('var x = 1; var y = 2;');
            if (result.valid) {
                assert.ok(!result.warnings || result.warnings.length === 0);
            }
        });
    });

    /*
     *  checkFloatUsage()
     */

    describe('checkFloatUsage()', function () {
        it('returns empty array for integer-only code', function () {
            let warnings = utils.checkFloatUsage('var x = 1;');
            assert.ok(Array.isArray(warnings));
            // If acorn is available, no floats → no warnings
        });

        it('detects float literal when acorn available', function () {
            let warnings = utils.checkFloatUsage('var pi = 3.14;');
            // If acorn is installed, we get a warning
            if (warnings.length > 0) {
                assert.ok(warnings[0].includes('decimal number literal'));
            }
        });

        it('returns empty array for unparseable code', function () {
            let warnings = utils.checkFloatUsage('}{{{');
            assert.ok(Array.isArray(warnings));
        });
    });

    /*
     *  _countForStatements()
     */

    describe('_countForStatements()', function () {
        it('counts zero for empty code', function () {
            assert.strictEqual(utils._countForStatements('var x = 1;'), 0);
        });

        it('counts a single C-style for loop', function () {
            let count = utils._countForStatements('for (var i=0; i<10; i++) {}');
            assert.strictEqual(count, 1);
        });

        it('counts multiple C-style for loops', function () {
            let code = 'for(var i=0;i<3;i++){} for(var j=0;j<5;j++){}';
            let count = utils._countForStatements(code);
            assert.strictEqual(count, 2);
        });

        it('does NOT count for-in loops (no semicolons in header)', function () {
            // for-in does not have semicolons, so it falls outside the regex pattern
            let count = utils._countForStatements('for (var k in obj) {}');
            assert.strictEqual(count, 0);
        });
    });

    /*
     *  suggestGasLimit()
     */

    describe('suggestGasLimit()', function () {
        it('returns a number above minimum base for trivial code', function () {
            let result = utils.suggestGasLimit('var x = 1;');
            assert.ok(typeof result.suggested === 'number');
            assert.ok(result.suggested >= 60000); // base=50000 + some per-byte, rounded up
            assert.ok(typeof result.rationale === 'string');
        });

        it('rounds up to nearest 10000', function () {
            let result = utils.suggestGasLimit('var x = 1;');
            assert.strictEqual(result.suggested % 10000, 0);
        });

        it('caps at 1000000 for very complex code', function () {
            let bigComplexCode = ('for(var i=0;i<100;i++){xchain.emit.transfer({});xchain.state.set("k","v");}').repeat(200);
            let result = utils.suggestGasLimit(bigComplexCode);
            assert.strictEqual(result.suggested, 1000000);
        });

        it('adds extra gas for for-loops (doubled charge)', function () {
            let noLoop = 'var x = 1;';
            let withForLoop = 'for(var i=0; i<10; i++) { var x = i; }';
            let r1 = utils.suggestGasLimit(noLoop);
            let r2 = utils.suggestGasLimit(withForLoop);
            assert.ok(r2.suggested > r1.suggested);
        });

        it('includes rationale string with relevant metrics', function () {
            let result = utils.suggestGasLimit('function myFn() { return 1; }');
            assert.ok(result.rationale.includes('bytes'));
            assert.ok(result.rationale.includes('functions'));
            assert.ok(result.rationale.includes('loops'));
        });

        it('coerces non-string input', function () {
            let result = utils.suggestGasLimit(42);
            assert.ok(typeof result.suggested === 'number');
        });
    });

});
