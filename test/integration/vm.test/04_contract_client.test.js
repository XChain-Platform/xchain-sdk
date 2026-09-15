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
const ContractClient = require('../../../src/contract/client.js');
const { SDKContractError } = require('../../../src/utils/errors.js');

// ContractClient

describe('ContractClient', function () {

    it('constructor stores contractActionIndex', function () {
        let mockSdk = {};
        let client = new ContractClient(mockSdk, 12345);
        expect(client.contractActionIndex).to.equal(12345);
    });

    it('constructor rejects missing contractActionIndex', function () {
        expect(() => new ContractClient({}, undefined)).to.throw(SDKContractError);
        expect(() => new ContractClient({}, null)).to.throw(SDKContractError);
    });

    it('call() delegates to sdk.execute()', async function () {
        let captured = null;
        let mockSdk = {
            execute: async function(params, encoder) { captured = { params, encoder }; return { action: 'EXECUTE' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        let result = await client.call('swap', ['TOKENA', '100'], { pubkey: 'pk' });

        expect(result.action).to.equal('EXECUTE');
        expect(captured.params.contractActionIndex).to.equal(42);
        expect(captured.params.method).to.equal('swap');
        expect(captured.params.params).to.deep.equal(['TOKENA', '100']);
        expect(captured.encoder.pubkey).to.equal('pk');
    });

    it('deposit() delegates to sdk.deposit()', async function () {
        let captured = null;
        let mockSdk = {
            deposit: async function(params, encoder) { captured = params; return { action: 'DEPOSIT' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        await client.deposit('TOKEN', '500');

        expect(captured.contractActionIndex).to.equal(42);
        expect(captured.tick).to.equal('TOKEN');
        expect(captured.quantity).to.equal('500');
    });

    it('withdraw() delegates to sdk.withdraw()', async function () {
        let captured = null;
        let mockSdk = {
            withdraw: async function(params, encoder) { captured = params; return { action: 'WITHDRAW' }; }
        };
        let client = new ContractClient(mockSdk, 42);
        await client.withdraw('TOKEN', '250');

        expect(captured.contractActionIndex).to.equal(42);
        expect(captured.tick).to.equal('TOKEN');
        expect(captured.quantity).to.equal('250');
    });
});
