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

// Module exports

describe('VM module exports', function () {

    it('exports SDKContractError', function () {
        const mod = require('../../../index.js');
        expect(mod).to.have.property('SDKContractError');
        expect(mod.SDKContractError).to.be.a('function');
    });

    it('exports ContractClient', function () {
        const mod = require('../../../index.js');
        expect(mod).to.have.property('ContractClient');
        expect(mod.ContractClient).to.be.a('function');
    });

    it('exports ContractUtils', function () {
        const mod = require('../../../index.js');
        expect(mod).to.have.property('ContractUtils');
        expect(mod.ContractUtils).to.be.a('function');
    });

    it('XChainSDK has contracts namespace', function () {
        const { XChainSDK } = require('../../../index.js');
        let sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk.contracts).to.be.an.instanceOf(require('../../../src/contract/utils.js'));
    });

    it('XChainSDK has contract() factory', function () {
        const { XChainSDK } = require('../../../index.js');
        let sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk.contract).to.be.a('function');
        let client = sdk.contract(123);
        expect(client).to.be.an.instanceOf(require('../../../src/contract/client.js'));
        expect(client.contractActionIndex).to.equal(123);
    });
});
