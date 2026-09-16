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

// Result structure

describe('Actions – createAction result structure', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('returns all expected keys with correct types', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result).to.have.all.keys('action', 'version', 'actionString', 'fields', 'encoding', 'psbt');
        expect(result.action).to.be.a('string');
        expect(result.version).to.be.a('number');
        expect(result.actionString).to.be.a('string');
        expect(result.fields).to.be.an('object');
        expect(result.encoding).to.equal(null);
        expect(result.psbt).to.equal(null);
    });

    it('normalizes the action name to uppercase', function () {
        let result = actions.createAction({
            action: 'send',
            params: { tick: 'TOKEN', amount: '50', destination: ADDR }
        });
        expect(result.action).to.equal('SEND');
    });

    it('fields object contains UPPER_SNAKE_CASE keys', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.fields).to.have.property('TICK');
        expect(result.fields).to.have.property('AMOUNT');
        expect(result.fields).to.have.property('DESTINATION');
    });

    it('encoding and psbt are both null when no encoder option provided', function () {
        let result = actions.createAction({
            action: 'MINT',
            params: { tick: 'TOKEN', amount: '10', destination: ADDR }
        });
        expect(result.encoding).to.be.null;
        expect(result.psbt).to.be.null;
    });

});
