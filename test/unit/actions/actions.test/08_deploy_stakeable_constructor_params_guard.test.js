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
const { SDKValidationError } = require('../../../../src/utils/errors.js');
const { createActions } = require('./helpers/create_actions.js');

// DEPLOY stakeable formats: CONSTRUCTOR_PARAMS is a single wire field in
// v1/v3, so a multi-element array must fail loudly instead of String()-
// joining into one comma-corrupted constructor arg on an immutable deploy.

describe('Actions – DEPLOY stakeable CONSTRUCTOR_PARAMS guard', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    const CODE = 'contract Test {}';

    it('rejects multi-element constructorParams on a v1 (stakeable) DEPLOY', function () {
        expect(() => actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice', '1000'],
                cooldownBlocks: 50
            }
        })).to.throw(SDKValidationError, /at most one entry/);
    });

    it('accepts a single constructorParams entry on a v1 (stakeable) DEPLOY', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice'],
                cooldownBlocks: 50
            }
        });
        expect(result.version).to.equal(1);
        let parts = result.actionString.split('|');
        expect(parts[4]).to.equal('alice');       // single CONSTRUCTOR_PARAMS field
        expect(parts[5]).to.equal('50');          // COOLDOWN_BLOCKS follows intact
    });

    it('still expands multi-element constructorParams on a v0 (rest-field) DEPLOY', function () {
        let result = actions.createAction({
            action: 'DEPLOY',
            params: {
                code: CODE, gasLimit: '100',
                constructorParams: ['alice', '1000']
            }
        });
        expect(result.version).to.equal(0);
        let parts = result.actionString.split('|');
        expect(parts.slice(4)).to.deep.equal(['alice', '1000']); // separate segments
    });
});
