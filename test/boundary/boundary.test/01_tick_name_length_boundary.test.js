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
 * XChain Platform SDK - Boundary Condition Tests
 *
 * Tests exact limit values for OP_RETURN encoding, field lengths,
 * numeric ranges, and format constraints.
 *
 ********************************************************************/

const { expect } = require('chai');
const config = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// TICK name length boundary (4 tests)

describe('TICK name length boundary', function () {

    let actions;

    before(function () {
        actions = createActions();
    });

    it('accepts a TICK name of exactly 1 character on ISSUE', function () {
        let result = actions.createAction({ action: 'ISSUE', params: { tick: 'A' } });
        expect(result.actionString).to.include('A');
    });

    it('accepts a TICK name of exactly 250 characters on ISSUE', function () {
        let tick = 'A'.repeat(250);
        let result = actions.createAction({ action: 'ISSUE', params: { tick } });
        expect(result.actionString).to.include(tick);
    });

    it('rejects a TICK name of exactly 251 characters on ISSUE (INVALID_TICK_NAME)', function () {
        let tick = 'A'.repeat(251);
        expect(function () {
            actions.createAction({ action: 'ISSUE', params: { tick } });
        }).to.throw().and.satisfy(function (err) {
            return err.code === 'INVALID_TICK_NAME';
        });
    });

    it('rejects an empty TICK name on ISSUE (MISSING_REQUIRED_FIELD)', function () {
        expect(function () {
            actions.createAction({ action: 'ISSUE', params: { tick: '' } });
        }).to.throw().and.satisfy(function (err) {
            return err.code === 'MISSING_REQUIRED_FIELD';
        });
    });

});
