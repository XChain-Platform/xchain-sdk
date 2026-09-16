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

// Edge cases and additional coverage

describe('Actions – edge cases', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('params defaults to empty object when not provided', function () {
        // ADDRESS has no required fields, so createAction({ action }) should work
        expect(function () {
            actions.createAction({ action: 'ADDRESS' });
        }).to.not.throw();
    });

    it('action name is case-insensitive', function () {
        let r1 = actions.createAction({
            action: 'send',
            params: { tick: 'TOKEN', amount: '1', destination: ADDR }
        });
        let r2 = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '1', destination: ADDR }
        });
        expect(r1.action).to.equal('SEND');
        expect(r1.actionString).to.equal(r2.actionString);
    });

    it('trailing empty fields are trimmed from actionString', function () {
        // SEND with no memo, trailing MEMO slot should be removed
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.actionString).to.not.match(/\|$/);
    });

    it('SEND actionString format is SEND|VERSION|TICK|AMOUNT|DESTINATION', function () {
        let result = actions.createAction({
            action: 'SEND',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR }
        });
        expect(result.actionString).to.equal('SEND|0|TOKEN|100|' + ADDR);
    });

    it('MINT actionString format is MINT|VERSION|TICK|AMOUNT|DESTINATION', function () {
        let result = actions.createAction({
            action: 'MINT',
            params: { tick: 'TOKEN', amount: '1000', destination: ADDR }
        });
        expect(result.actionString).to.equal('MINT|0|TOKEN|1000|' + ADDR);
    });

});


describe('Actions – edge cases', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('SLEEP actionString format is SLEEP|VERSION|RESUME_BLOCK', function () {
        let result = actions.createAction({
            action: 'SLEEP',
            params: { resumeBlock: 500000 }
        });
        expect(result.actionString).to.equal('SLEEP|0|500000');
    });

    it('ADDRESS with feePreference and requireMemo serializes correctly', function () {
        let result = actions.createAction({
            action: 'ADDRESS',
            params: { feePreference: 2, requireMemo: 1 }
        });
        expect(result.actionString).to.equal('ADDRESS|0|2|1');
    });

    it('BROADCAST with message and value uses v0 format', function () {
        let result = actions.createAction({
            action: 'BROADCAST',
            params: { message: 'hello', value: '100' }
        });
        expect(result.version).to.equal(0);
        expect(result.actionString).to.equal('BROADCAST|0|hello|100');
    });

    it('CALLBACK actionString includes tick', function () {
        let result = actions.createAction({
            action: 'CALLBACK',
            params: { tick: 'MYTOKEN' }
        });
        expect(result.actionString).to.equal('CALLBACK|0|MYTOKEN');
    });

    it('DESTROY actionString includes tick and amount', function () {
        let result = actions.createAction({
            action: 'DESTROY',
            params: { tick: 'TOKEN', amount: '500' }
        });
        expect(result.actionString).to.equal('DESTROY|0|TOKEN|500');
    });

    it('SWEEP actionString includes destination + per-primitive flags (balances, ownerships, orders, swaps, dispensers)', function () {
        let result = actions.createAction({
            action: 'SWEEP',
            params: { destination: ADDR, balances: 1, ownerships: 1, orders: 0, swaps: 0, dispensers: 0 }
        });
        expect(result.actionString).to.equal('SWEEP|0|' + ADDR + '|1|1|0|0|0');
    });

});
