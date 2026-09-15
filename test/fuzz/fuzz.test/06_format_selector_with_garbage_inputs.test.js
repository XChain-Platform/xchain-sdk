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
 * XChain Platform SDK - Fuzz Tests
 *
 * Core principle: NO test should cause an unhandled exception.
 * Every test must either succeed or throw a clean SDKError subclass.
 * A raw TypeError, RangeError, etc. is a bug.
 *
 ********************************************************************/

const { expect }    = require('chai');
const FormatSelector = require('../../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../../src/utils/errors.js');

// Raw error types that must NEVER escape from SDK boundaries
const RAW_ERROR_CONSTRUCTORS = [TypeError, RangeError, SyntaxError, URIError, EvalError];

function assertCleanError(e) {
    // Must be an Error instance
    expect(e, 'thrown value must be an Error').to.be.instanceOf(Error);
    // Must NOT be a raw JS runtime error
    for (let RawErr of RAW_ERROR_CONSTRUCTORS) {
        expect(e, `must not be a raw ${RawErr.name}`).to.not.be.instanceOf(RawErr);
    }
    // Name must start with "SDK"
    expect(e.name, 'error name must start with SDK').to.match(/^SDK/);
}

// Group 7: FormatSelector with garbage inputs

describe('Fuzz – Group 7: FormatSelector with garbage inputs', function() {

    it('select(null, {}) → SDKFormatError, never TypeError', function() {
        let threw = false;
        try {
            FormatSelector.select(null, {});
        } catch (e) {
            threw = true;
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKFormatError);
        }
        expect(threw, 'Expected SDKFormatError for null action').to.be.true;
    });

    it("select('', {}) → SDKFormatError", function() {
        let threw = false;
        try {
            FormatSelector.select('', {});
        } catch (e) {
            threw = true;
            assertCleanError(e);
            expect(e).to.be.instanceOf(SDKFormatError);
        }
        expect(threw, 'Expected SDKFormatError for empty string action').to.be.true;
    });

    it("select('SEND', null) → clean throw or return, never crash", function() {
        let threw = false;
        try {
            let result = FormatSelector.select('SEND', null);
            // If null fields are tolerated, result should be an object
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

describe('Fuzz – Group 7: FormatSelector with garbage inputs', function() {

    it("select('SEND', 'not an object') → clean throw or return, never crash", function() {
        let threw = false;
        try {
            let result = FormatSelector.select('SEND', 'not an object');
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it("select('SEND', deeply nested object) → must not crash", function() {
        // Build a deeply nested object
        let deep = {};
        let cursor = deep;
        for (let i = 0; i < 100; i++) {
            cursor.child = {};
            cursor = cursor.child;
        }
        cursor.TICK = 'TOK';

        let threw = false;
        try {
            let result = FormatSelector.select('SEND', deep);
            expect(result).to.be.an('object');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('serialize("SEND", 1, null) → clean throw or result, never crash', function() {
        let threw = false;
        try {
            let result = FormatSelector.serialize('SEND', 1, null);
            // If null is tolerated, result should be a string
            expect(result).to.be.a('string');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});
