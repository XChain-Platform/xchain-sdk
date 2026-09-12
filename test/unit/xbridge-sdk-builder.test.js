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
 *********************************************************************/

'use strict';

// XChainSDK.xbridge() builder method (row 8, xchain-bridge.md / xchain-token-bridge.md).
// This is the raw wrapper the sdk-action-surface doc guard requires to exist
// (test/sdk-action-surface.test.js): one method per invocable ACTION, same shape
// as sweep/list/issue elsewhere on the class. It composes the wire string through
// the real Actions/formats pipeline rather than a mock, so a field-name or
// version-key mismatch against formats.js XBRIDGE fails here instead of only on
// chain.

const { expect } = require('chai');
const { XChainSDK } = require('../../index.js');

describe('XChainSDK.xbridge()', () => {

    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

    function assertAction(result, expectedVersion) {
        expect(result).to.be.an('object');
        expect(result.action).to.equal('XBRIDGE');
        expect(String(result.version)).to.equal(String(expectedVersion));
        expect(result.actionString).to.be.a('string').and.to.have.length.above(0);
        expect(result.actionString.startsWith('XBRIDGE|')).to.equal(true);
    }

    it('v0 (lock XCHAIN on BTC): camelCase params normalize to the wire fields', async () => {
        const result = await sdk.xbridge({
            version: 0,
            destCoin: 'DOGE',
            destAddress: 'D8bFJYQ6JZ4tSjzZbXqXYh2vN3xKzQpump',
            amount: '500',
            memo: ''
        });
        assertAction(result, 0);
        expect(result.actionString).to.equal('XBRIDGE|0|DOGE|D8bFJYQ6JZ4tSjzZbXqXYh2vN3xKzQpump|500');
    });

    it('v1 (burn XCHAIN, release on BTC)', async () => {
        const result = await sdk.xbridge({
            version: 1,
            btcAddress: '1ExampleAddressXXXXXXXXXXXXXXXXXXX',
            amount: '200',
            memo: ''
        });
        assertAction(result, 1);
        expect(result.actionString).to.equal('XBRIDGE|1|1ExampleAddressXXXXXXXXXXXXXXXXXXX|200');
    });

    it('v3 (lock a general token on its origin chain)', async () => {
        const result = await sdk.xbridge({
            version: 3,
            tick: 'PEPECASH',
            destCoin: 'DOGE',
            destAddress: 'D8bFJYQ6JZ4tSjzZbXqXYh2vN3xKzQpump',
            amount: '1000',
            memo: ''
        });
        assertAction(result, 3);
        expect(result.actionString).to.equal('XBRIDGE|3|PEPECASH|DOGE|D8bFJYQ6JZ4tSjzZbXqXYh2vN3xKzQpump|1000');
    });

    it('v4 (burn a bridged token back to its origin chain)', async () => {
        const result = await sdk.xbridge({
            version: 4,
            tick: 'BTC.PEPECASH',
            originAddress: '1ExampleAddressXXXXXXXXXXXXXXXXXXX',
            amount: '250',
            memo: ''
        });
        assertAction(result, 4);
        expect(result.actionString).to.equal('XBRIDGE|4|BTC.PEPECASH|1ExampleAddressXXXXXXXXXXXXXXXXXXX|250');
    });

    it('accepts a third opts argument without changing the result (symmetry with deploy())', async () => {
        const result = await sdk.xbridge({
            version: 0,
            destCoin: 'DOGE',
            destAddress: 'D8bFJYQ6JZ4tSjzZbXqXYh2vN3xKzQpump',
            amount: '500',
            memo: ''
        }, undefined, { network: 'regtest' });
        assertAction(result, 0);
    });

});
