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
const { SDKValidationError } = require('../../../src/utils/errors.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// BatchBuilder – VM action integration

describe('BatchBuilder – VM actions', function () {

    let sdk;
    beforeEach(function () { sdk = new XChainSDK({ network: 'bitcoin-regtest' }); });

    it('allows EXECUTE in BATCH', async function () {
        let result = await sdk.batch()
            .send({ tick: 'TOKEN', amount: 100, destination: ADDR })
            .execute({ contractActionIndex: 42, method: 'swap', params: ['A', '100'] })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('EXECUTE|0|42|swap|A|100');
    });

    it('allows DEPOSIT in BATCH', async function () {
        let result = await sdk.batch()
            .deposit({ contractActionIndex: 42, tick: 'TOKEN', quantity: '500' })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('DEPOSIT|0|42|TOKEN|500');
    });

    it('allows WITHDRAW in BATCH', async function () {
        let result = await sdk.batch()
            .withdraw({ contractActionIndex: 42, tick: 'TOKEN', quantity: '250' })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include('WITHDRAW|0|42|TOKEN|250');
    });

    // build() is async, so a synchronous expect(...).to.throw() never sees the
    // BATCH_CONSTRAINT: it inspected a returned promise, found no throw, and
    // failed while the rule was working perfectly. Await the rejection instead.
    it('rejects DEPLOY in BATCH', async function () {
        let caught = null;
        try {
            await sdk.batch()
                .add('DEPLOY', { code: 'x', gasLimit: 100000 })
                .build();
        } catch (err) {
            caught = err;
        }
        expect(caught, 'DEPLOY in a BATCH must be refused').to.be.instanceOf(SDKValidationError);
        expect(caught.code).to.equal('BATCH_CONSTRAINT');
        expect(caught.message).to.match(/DEPLOY/);
    });
});
