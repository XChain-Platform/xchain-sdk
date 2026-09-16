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
 * XChain Platform SDK - FormatSelector Tests
 *
 * Comprehensive Mocha + Chai test suite for the FormatSelector class.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../../../src/utils/errors.js');

// select() - explicit VERSION shape
//
// VERSION is a non-negative integer on the wire. The old code ran a bare
// Number() over whatever the caller passed, which read true, [1], '0x1', '1e0',
// '1.0' and ' 1 ' as version 1, and '' and [] as version 0. The format lookup
// bounded the RESULT to a defined version so nothing misbehaved, but this SDK
// is published and the accepted shape of a public input should not be whatever
// Number() manages to salvage.

describe('FormatSelector.select(): explicit VERSION must be a canonical integer', function () {

    const ACCEPTED = [
        ['integer number', 1, 1],
        ['zero', 0, 0],
        ['decimal-integer string', '1', 1],
        ['zero string', '0', 0],
        // A leading zero cannot mean a different version, so rejecting it would
        // only break callers for no gain.
        ['leading-zero string', '01', 1],
    ];

    for (const [label, input, expected] of ACCEPTED) {
        it('accepts a ' + label, function () {
            const r = FormatSelector.select('SEND', { TICK: 'T', AMOUNT: '1', DESTINATION: 'd' }, input);
            expect(r.version).to.equal(expected);
        });
    }

    const REJECTED = [
        ['boolean true', true],
        ['hex string', '0x1'],
        ['exponent string', '1e0'],
        ['decimal-point string', '1.0'],
        ['whitespace-padded string', ' 1 '],
        ['empty string', ''],
        ['array', [1]],
        ['empty array', []],
        ['object', {}],
        ['fractional number', 1.5],
        ['negative number', -1],
        ['NaN', NaN],
    ];

    for (const [label, input] of REJECTED) {
        it('rejects a ' + label + ' with INVALID_VERSION', function () {
            expect(() => FormatSelector.select('SEND', { TICK: 'T', AMOUNT: '1', DESTINATION: 'd' }, input))
                .to.throw(SDKFormatError, /VERSION must be a non-negative integer/);
        });
    }

    it('still rejects a well-shaped version the action does not define', function () {
        expect(() => FormatSelector.select('SEND', { TICK: 'T', AMOUNT: '1', DESTINATION: 'd' }, 99))
            .to.throw(SDKFormatError, /Version 99 is not defined for SEND/);
    });

    it('the error names the value it refused, so the caller can see what it sent', function () {
        try {
            FormatSelector.select('SEND', { TICK: 'T', AMOUNT: '1', DESTINATION: 'd' }, '0x1');
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.code).to.equal('INVALID_VERSION');
            expect(e.message).to.include('"0x1"');
            expect(e.details.version).to.equal('0x1');
        }
    });
});
