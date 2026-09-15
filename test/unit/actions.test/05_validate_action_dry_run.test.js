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
 * XChain Platform SDK - Actions Class Tests
 *
 * Comprehensive unit tests for the Actions class covering all 19 ACTION
 * types, format version selection, result structure, error cases,
 * pre-flight encoding validation, validateAction dry-run, and
 * introspection methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { ADDR, createActions } = require('./helpers/create_actions.js');

// validateAction() dry-run

describe('Actions – validateAction() dry-run', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('returns { valid: true, errors: [] } for valid SEND params', function () {
        let result = actions.validateAction('SEND', {
            tick: 'TOKEN',
            amount: '100',
            destination: ADDR
        });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

    it('returns { valid: false, errors: [...] } for SEND missing tick', function () {
        let result = actions.validateAction('SEND', {
            amount: '100',
            destination: ADDR
        });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
    });

    it('returns { valid: false, errors: [...] } for SEND missing destination', function () {
        let result = actions.validateAction('SEND', {
            tick: 'TOKEN',
            amount: '100'
        });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
        let codes = result.errors.map(function (e) { return e.code; });
        expect(codes).to.include('MISSING_REQUIRED_FIELD');
    });

    it('returns { valid: true } for ISSUE with a sub-TICK (dot is the parent/child separator)', function () {
        let result = actions.validateAction('ISSUE', { tick: 'TOKEN.CHILD' });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

});


describe('Actions – validateAction() dry-run', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('returns { valid: false, errors: [...] } for ISSUE tick with an empty dot segment', function () {
        let result = actions.validateAction('ISSUE', { tick: 'TOKEN..CHILD' });
        expect(result.valid).to.equal(false);
        expect(result.errors).to.be.an('array').with.length.above(0);
    });

    it('returns { valid: true, errors: [] } for valid ISSUE tick', function () {
        let result = actions.validateAction('ISSUE', { tick: 'VALIDTOKEN' });
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.an('array').that.is.empty;
    });

    it('does not throw even for invalid params: returns errors object instead', function () {
        expect(function () {
            actions.validateAction('SEND', {});
        }).to.not.throw();
    });

    it('returns valid: true for valid MINT params', function () {
        let result = actions.validateAction('MINT', {
            tick: 'TOKEN',
            amount: '500',
            destination: ADDR
        });
        expect(result.valid).to.equal(true);
    });

    it('returns valid: false for ADDRESS with invalid feePreference value', function () {
        let result = actions.validateAction('ADDRESS', { feePreference: 99 });
        expect(result.valid).to.equal(false);
    });

});
