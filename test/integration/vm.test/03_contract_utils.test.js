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
 *
 * XChain Platform SDK - VM Integration Tests
 *
 * Comprehensive tests for VM action support: DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW actions, contract utilities, contract client, format
 * selection, validation, batch integration, and explorer methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const ContractUtils = require('../../../src/contract/utils.js');
const { SDKContractError } = require('../../../src/utils/errors.js');

// Simple contract source for testing
const SIMPLE_CONTRACT = `
module.exports = {
    greet: function(xchain) {
        return 'hello ' + xchain.getInputParam(0);
    }
};
`;

const LARGE_CONTRACT = 'x'.repeat(65537); // exceeds 64KB

// ContractUtils

describe('ContractUtils', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    describe('encode / decode', function () {

        it('round-trips UTF-8 source code', function () {
            let b64 = utils.encode(SIMPLE_CONTRACT);
            expect(b64).to.match(/^[A-Za-z0-9+/]*={0,2}$/);
            let decoded = utils.decode(b64);
            expect(decoded).to.equal(SIMPLE_CONTRACT);
        });

        it('encode throws for non-string input', function () {
            expect(() => utils.encode(123)).to.throw(SDKContractError);
        });

        it('decode throws for invalid base64', function () {
            expect(() => utils.decode('not-base64!')).to.throw(SDKContractError);
        });
    });

    describe('checkCodeSize', function () {

        it('accepts code within limit', function () {
            let result = utils.checkCodeSize('var x = 1;');
            expect(result.withinLimit).to.be.true;
            expect(result.bytes).to.be.lessThan(65536);
            expect(result.limit).to.equal(65536);
        });

        it('rejects code exceeding limit', function () {
            let result = utils.checkCodeSize(LARGE_CONTRACT);
            expect(result.withinLimit).to.be.false;
            expect(result.bytes).to.be.greaterThan(65536);
        });
    });
});

describe('ContractUtils', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    describe('validate', function () {

        it('accepts valid JavaScript', function () {
            let result = utils.validate('module.exports = function() { return 1; }');
            expect(result.valid).to.be.true;
        });

        it('rejects syntax errors', function () {
            let result = utils.validate('function( { broken');
            expect(result.valid).to.be.false;
            // The wording comes from lint_core.js, which is vendored
            // byte-identical from xchain-vm and is the consensus linter: the
            // unparseable-code rule reports "unsupported syntax (ES<n> maximum)"
            // and carries acorn's own message. Assert that, not the older
            // SDK-local "Syntax error" text, so this file cannot drift from the
            // linter that actually decides.
            expect(result.error).to.include('unsupported syntax');
        });

        it('rejects __gas usage', function () {
            let result = utils.validate('var __gas = 1;');
            expect(result.valid).to.be.false;
            expect(result.error).to.include('__gas');
        });

        it('rejects oversized code', function () {
            let result = utils.validate(LARGE_CONTRACT);
            expect(result.valid).to.be.false;
            expect(result.error).to.include('byte limit');
        });

        it('returns float warnings', function () {
            let result = utils.validate('var x = 0.5; module.exports = function() { return x; }');
            expect(result.valid).to.be.true;
            // Same vendored-linter rule as above: the float-literal warning reads
            // "WARNING: decimal number literal (0.5) detected at line N".
            // The unconditional length check matters as much as the text: with
            // `if (result.warnings)` alone this test passed on a build that
            // emitted no warning at all.
            expect(result.warnings).to.be.an('array');
            expect(result.warnings.length).to.be.greaterThan(0);
            expect(result.warnings[0]).to.include('decimal number literal');
        });

        it('rejects non-string input', function () {
            let result = utils.validate(123);
            expect(result.valid).to.be.false;
        });
    });
});

describe('ContractUtils', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    describe('checkFloatUsage', function () {

        it('detects float literals', function () {
            let warnings = utils.checkFloatUsage('var price = 1.5; var rate = 0.01;');
            expect(warnings.length).to.be.greaterThan(0);
        });

        it('returns empty for integer-only code', function () {
            let warnings = utils.checkFloatUsage('var x = 1; var y = 2;');
            expect(warnings).to.have.lengthOf(0);
        });
    });

    describe('suggestGasLimit', function () {

        it('returns a suggestion for simple code', function () {
            let result = utils.suggestGasLimit('module.exports = function() { return 1; }');
            expect(result.suggested).to.be.a('number');
            expect(result.suggested).to.be.greaterThan(0);
            expect(result.rationale).to.be.a('string');
        });

        it('suggests higher gas for complex code', function () {
            let simple = utils.suggestGasLimit('module.exports = function() { return 1; }');
            let complex = utils.suggestGasLimit(`
                module.exports = {
                    swap: function(xchain) {
                        for (var i = 0; i < 10; i++) {
                            xchain.state.set('k' + i, 'v');
                        }
                        xchain.emit.send({ tick: 'T', destination: 'addr', quantity: '1' });
                        xchain.emit.send({ tick: 'T', destination: 'addr', quantity: '2' });
                        return 'done';
                    }
                };
            `);
            expect(complex.suggested).to.be.greaterThan(simple.suggested);
        });
    });
});
