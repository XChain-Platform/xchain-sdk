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

// A version can be spelled two ways: params.VERSION, or a top-level `version` on
// the request (the shape sdk.decoder.parse() output carries). Both spellings must
// reach the same verdict: validation that runs before the top-level one is read
// checks version-dependent required fields against the AUTO-SELECTED format while a
// different version is serialized, and that malformed action broadcasts fine, burning
// the miner fee on an indexer rejection.
describe('Actions - top-level version reaches version-dependent validation', function () {
    let actions;
    beforeEach(function () { actions = createActions(); });

    it('rejects an incomplete VOTE v0 spelled top-level, as it does spelled in params', function () {
        const paramsSpelling   = () => actions.createAction({ action: 'VOTE', params: { VERSION: 0, TICK: 'TOKEN' } });
        const topLevelSpelling = () => actions.createAction({ action: 'VOTE', version: 0, params: { TICK: 'TOKEN' } });
        expect(paramsSpelling).to.throw(SDKValidationError, /END_BLOCK/);
        expect(topLevelSpelling).to.throw(SDKValidationError, /END_BLOCK/);
        // and with the same error code, not merely some error
        let a, b;
        try { paramsSpelling(); }   catch (e) { a = e.code; }
        try { topLevelSpelling(); } catch (e) { b = e.code; }
        expect(b).to.equal(a);
    });

    it('serializes a complete payload identically under either spelling', function () {
        const params      = { TICK: 'TOKEN', END_BLOCK: 900000, OPTIONS: ['yes', 'no'] };
        const viaParams   = actions.createAction({ action: 'VOTE', params: Object.assign({ VERSION: 0 }, params) });
        const viaTopLevel = actions.createAction({ action: 'VOTE', version: 0, params: Object.assign({}, params) });
        expect(viaTopLevel.actionString).to.equal(viaParams.actionString);
        expect(viaTopLevel.version).to.equal(viaParams.version);
    });

    it('lets a params-level VERSION win over a conflicting top-level version', function () {
        const result = actions.createAction({
            action: 'VOTE', version: 1,
            params: { VERSION: 0, TICK: 'TOKEN', END_BLOCK: 900000, OPTIONS: ['yes', 'no'] }
        });
        expect(result.version).to.equal(0);
    });
});
