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
const { SDKValidationError } = require('../../../src/utils/errors.js');
const { ADDR, createActions } = require('./helpers/create_actions.js');

// Error cases

describe('Actions – error cases', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('throws SDKValidationError when action field is missing', function () {
        expect(function () {
            actions.createAction({ params: { tick: 'TOKEN' } });
        }).to.throw(SDKValidationError).with.property('code', 'MISSING_ACTION');
    });

    it('throws SDKValidationError when action field is null', function () {
        expect(function () {
            actions.createAction(null);
        }).to.throw(SDKValidationError).with.property('code', 'MISSING_ACTION');
    });

    it('throws SDKValidationError for unknown ACTION type', function () {
        expect(function () {
            actions.createAction({ action: 'NOTANACTION', params: {} });
        }).to.throw(SDKValidationError).with.property('code', 'UNKNOWN_ACTION');
    });

    it('throws SDKValidationError for missing SEND required field: TICK', function () {
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { amount: '100', destination: ADDR }
            });
        }).to.throw(SDKValidationError);
    });

    it('throws SDKValidationError for missing SEND required field: DESTINATION', function () {
        expect(function () {
            actions.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100' }
            });
        }).to.throw(SDKValidationError);
    });

    it('SDKValidationError has a name property of "SDKValidationError"', function () {
        let err;
        try {
            actions.createAction({ params: {} });
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(SDKValidationError);
        expect(err.name).to.equal('SDKValidationError');
    });

});
