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
 * XChain Platform SDK - VM Integration Tests
 *
 * Comprehensive tests for VM action support: DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW actions, contract utilities, contract client, format
 * selection, validation, batch integration, and explorer methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const config  = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Factory: create a fresh Actions instance
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

// Round-trip tests

describe('VM Actions – round-trip serialize → verify', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    it('DEPLOY fields match action string', function () {
        let code = 'module.exports = function() { return 1; }';
        let b64 = Buffer.from(code, 'utf8').toString('base64');
        let result = actions.createAction({
            action: 'DEPLOY',
            params: { code: code, gasLimit: 200000 }
        });
        let parts = result.actionString.split('|');
        expect(parts[0]).to.equal('DEPLOY');
        expect(parts[1]).to.equal('0');
        expect(parts[2]).to.equal(b64);
        expect(parts[3]).to.equal('200000');
    });

    it('EXECUTE fields match action string', function () {
        let result = actions.createAction({
            action: 'EXECUTE',
            params: { contractActionIndex: 999, method: 'balanceOf', params: [ADDR] }
        });
        let parts = result.actionString.split('|');
        expect(parts[0]).to.equal('EXECUTE');
        expect(parts[1]).to.equal('0');
        expect(parts[2]).to.equal('999');
        expect(parts[3]).to.equal('balanceOf');
        expect(parts[4]).to.equal(ADDR);
    });

    it('DEPOSIT fields match action string', function () {
        let result = actions.createAction({
            action: 'DEPOSIT',
            params: { contractActionIndex: 500, tick: 'XCHAIN', quantity: '1000000' }
        });
        let parts = result.actionString.split('|');
        expect(parts).to.deep.equal(['DEPOSIT', '0', '500', 'XCHAIN', '1000000']);
    });

    it('WITHDRAW fields match action string', function () {
        let result = actions.createAction({
            action: 'WITHDRAW',
            params: { contractActionIndex: 500, tick: 'XCHAIN', quantity: '500000' }
        });
        let parts = result.actionString.split('|');
        expect(parts).to.deep.equal(['WITHDRAW', '0', '500', 'XCHAIN', '500000']);
    });
});
