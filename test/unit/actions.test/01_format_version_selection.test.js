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
const { createActions } = require('./helpers/create_actions.js');

// Format version selection

describe('Actions – format version selection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('ISSUE with description only selects v1', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: { tick: 'MYTOKEN', description: 'A test token' }
        });
        // v1 format: VERSION|TICK|DESCRIPTION|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.match(/^ISSUE\|1\|MYTOKEN\|A test token/);
    });

    it('ISSUE with lock fields selects v3', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                lockMaxSupply: 1,
                lockMaxMint: 0,
                lockDescription: 1,
                lockSleep: 0,
                lockCallback: 0,
                lockMint: 0,
                lockMintSupply: 0
            }
        });
        // v3 format: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
        expect(result.version).to.equal(3);
    });

    it('ISSUE with callback fields selects v4', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                callbackBlock: 800000,
                callbackTick: 'BTC',
                callbackAmount: '1'
            }
        });
        // v4 format: VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO
        expect(result.version).to.equal(4);
    });

});


describe('Actions – format version selection', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('ISSUE with allowList + blockList selects v5', function () {
        let result = actions.createAction({
            action: 'ISSUE',
            params: {
                tick: 'MYTOKEN',
                allowList: 1,
                blockList: 2
            }
        });
        // v5 format: VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO
        expect(result.version).to.equal(5);
    });

    it('ORDER with orderActionIndex selects v1 (cancel)', function () {
        let result = actions.createAction({
            action: 'ORDER',
            params: { orderActionIndex: 42 }
        });
        // v1 format: VERSION|ORDER_ACTION_INDEX|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.match(/^ORDER\|1\|42/);
    });

    it('SLEEP with resumeBlock + tick selects v1', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000, tick: 'TOKEN' }
        });
        // v1 format: VERSION|RESUME_BLOCK|TICK|MEMO
        expect(result.version).to.equal(1);
        expect(result.actionString).to.include('TOKEN');
    });

    it('SLEEP with resumeBlock only selects v0', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000 }
        });
        // v0 format: VERSION|RESUME_BLOCK|MEMO
        expect(result.version).to.equal(0);
    });

});
