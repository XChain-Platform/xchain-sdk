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
const { XChainSDK } = require('../../../index.js');

// XChainSDK convenience methods

describe('XChainSDK – VM convenience methods', function () {

    let sdk;
    beforeEach(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest' }); });

    it('deploy() creates DEPLOY action', async function () {
        let result = await sdk.deploy({ code: 'var x = 1;', gasLimit: 100000 });
        expect(result.action).to.equal('DEPLOY');
        expect(result.actionString).to.match(/^DEPLOY\|0\|/);
    });

    it('execute() creates EXECUTE action', async function () {
        let result = await sdk.execute({ contractActionIndex: 42, method: 'swap', params: ['A', '100'] });
        expect(result.action).to.equal('EXECUTE');
        expect(result.actionString).to.equal('EXECUTE|0|42|swap|A|100');
    });

    it('deposit() creates DEPOSIT action', async function () {
        let result = await sdk.deposit({ contractActionIndex: 42, tick: 'TOKEN', quantity: '500' });
        expect(result.action).to.equal('DEPOSIT');
        expect(result.actionString).to.equal('DEPOSIT|0|42|TOKEN|500');
    });

    it('withdraw() creates WITHDRAW action', async function () {
        let result = await sdk.withdraw({ contractActionIndex: 42, tick: 'TOKEN', quantity: '250' });
        expect(result.action).to.equal('WITHDRAW');
        expect(result.actionString).to.equal('WITHDRAW|0|42|TOKEN|250');
    });

    it('getActions() includes VM actions', function () {
        let allActions = sdk.getActions();
        expect(allActions).to.include('DEPLOY');
        expect(allActions).to.include('EXECUTE');
        expect(allActions).to.include('DEPOSIT');
        expect(allActions).to.include('WITHDRAW');
    });

    it('validateAction() works for VM actions', function () {
        let valid = sdk.validateAction('EXECUTE', { contractActionIndex: 1, method: 'test' });
        expect(valid.valid).to.be.true;

        let invalid = sdk.validateAction('EXECUTE', { contractActionIndex: 1 });
        expect(invalid.valid).to.be.false;
    });
});
