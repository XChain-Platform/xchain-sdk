// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { validateBetDetails } = require('../../../../src/protocol/validator/bet_details.js');

const limits = {
    MAX_BET_DETAILS_LENGTH: 256,
    MAX_BET_DETAILS_DEPTH: 3
};

const validator = {
    buildError(code, message, extra) {
        return { code, message, ...extra };
    },
    isEmpty(value) {
        return value === null || value === undefined || value === '';
    }
};

function encode(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function expectInvalid(details, outcomes = '') {
    const errors = validateBetDetails(validator, details, outcomes, limits);
    expect(errors).to.have.length(1);
    expect(errors[0]).to.include({ code: 'INVALID_FIELD_VALUE', field: 'DETAILS' });
    return errors[0];
}

describe('validateBetDetails', function () {

    it('accepts a canonical base64 JSON object within the limits', function () {
        const errors = validateBetDetails(validator, encode({ title: 'Winner' }), '', limits);
        expect(errors).to.deep.equal([]);
    });

    it('rejects non-base64 text', function () {
        expectInvalid('not base64!');
    });

    it('rejects base64 that does not re-encode to itself', function () {
        expect(Buffer.from('e31=', 'base64').toString('base64')).to.equal('e30=');
        expectInvalid('e31=');
    });

    it('rejects a decoded payload over the length cap', function () {
        expectInvalid(encode({ pad: 'x'.repeat(limits.MAX_BET_DETAILS_LENGTH) }));
    });

    it('rejects non-JSON content', function () {
        expectInvalid(Buffer.from('{broken', 'utf8').toString('base64'));
    });

    it('rejects arrays and bare JSON values', function () {
        for (const value of [[], 'bare', 42, true, null]) expectInvalid(encode(value));
    });

    it('rejects nesting deeper than the depth cap', function () {
        const error = expectInvalid(encode({ outer: { inner: { value: true } } }));
        expect(error.message).to.match(/nests 4 levels deep, max 3/);
    });

    it('rejects DETAILS outcomes with a different order or count', function () {
        expectInvalid(encode({ outcomes: ['No', 'Yes'] }), 'Yes,No');
        expectInvalid(encode({ outcomes: ['Yes'] }), 'Yes,No');
    });

    it('accepts matching trimmed outcomes and an absent outcomes key', function () {
        expect(validateBetDetails(validator, encode({ outcomes: [' Yes ', 'No '] }), ' Yes, No ', limits))
            .to.deep.equal([]);
        expect(validateBetDetails(validator, encode({ title: 'Winner' }), 'Yes,No', limits))
            .to.deep.equal([]);
    });

});
