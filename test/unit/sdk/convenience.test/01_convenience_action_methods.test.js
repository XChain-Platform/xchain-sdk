/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

'use strict';

const { expect } = require('chai');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

const { XChainSDK } = require('../../../../index.js');
const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

// Helper: assert result has correct action name and a non-empty actionString
function assertAction(result, expectedAction) {
    expect(result).to.be.an('object');
    expect(result.action).to.equal(expectedAction);
    expect(result.actionString).to.be.a('string').and.to.have.length.above(0);
}

describe('Convenience action methods', () => {

    it('send() returns action SEND with valid actionString', async () => {
        const result = await sdk.send({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'SEND');
    });

    it('issue() returns action ISSUE with valid actionString', async () => {
        const result = await sdk.issue({ tick: 'T', description: 'test' });
        assertAction(result, 'ISSUE');
    });

    it('mint() returns action MINT with valid actionString', async () => {
        const result = await sdk.mint({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'MINT');
    });

    it('destroy() returns action DESTROY with valid actionString', async () => {
        const result = await sdk.destroy({ tick: 'T', amount: '1' });
        assertAction(result, 'DESTROY');
    });

    it('order() returns action ORDER with valid actionString', async () => {
        const result = await sdk.order({ giveTick: 'A', giveAmount: '1', getTick: 'B', getAmount: '1' });
        assertAction(result, 'ORDER');
    });

    it('broadcast() returns action BROADCAST with valid actionString', async () => {
        const result = await sdk.broadcast({ message: 'hi', value: '1' });
        assertAction(result, 'BROADCAST');
    });

    it('dispenser() returns action DISPENSER with valid actionString', async () => {
        const result = await sdk.dispenser({
            giveTick: 'A', giveAmount: '1', giveEscrow: '1',
            getTick: 'B', getAmount: '1'
        });
        assertAction(result, 'DISPENSER');
    });

    it('dividend() returns action DIVIDEND with valid actionString', async () => {
        const result = await sdk.dividend({ tick: 'T', dividendTick: 'P', amount: '1' });
        assertAction(result, 'DIVIDEND');
    });

    it('sweep() returns action SWEEP with valid actionString', async () => {
        const result = await sdk.sweep({ destination: ADDR, balances: 1, ownerships: 1, orders: 0, swaps: 0, dispensers: 0 });
        assertAction(result, 'SWEEP');
    });

    it('swap() returns action SWAP with valid actionString', async () => {
        const result = await sdk.swap({ giveTick: 'A', giveAmount: '1', getTick: 'B', getAmount: '1' });
        assertAction(result, 'SWAP');
    });

});
describe('Convenience action methods', () => {

    it('callback() returns action CALLBACK with valid actionString', async () => {
        const result = await sdk.callback({ tick: 'T' });
        assertAction(result, 'CALLBACK');
    });

    it('sleep() returns action SLEEP with valid actionString', async () => {
        const result = await sdk.sleep({ resumeBlock: 100 });
        assertAction(result, 'SLEEP');
    });

    it('airdrop() returns action AIRDROP with valid actionString', async () => {
        const result = await sdk.airdrop({ tick: 'T', amount: '1', listActionIndex: 1 });
        assertAction(result, 'AIRDROP');
    });

    it('message() returns action MESSAGE with valid actionString', async () => {
        const result = await sdk.message({ coin: 'BTC', destination: ADDR, plaintextMessage: 'hi' });
        assertAction(result, 'MESSAGE');
    });

    it('list() returns action LIST with valid actionString', async () => {
        const result = await sdk.list({ type: 1, item: 'T1' });
        assertAction(result, 'LIST');
    });

    it('link() returns action LINK with valid actionString', async () => {
        const result = await sdk.link({ coin1: 'BTC', coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2 });
        assertAction(result, 'LINK');
    });

    it('file() returns action FILE with valid actionString', async () => {
        const result = await sdk.file({ name: 'f', type: 1, title: 't' });
        assertAction(result, 'FILE');
    });

    it('address() returns action ADDRESS with valid actionString', async () => {
        const result = await sdk.address({ feePreference: 1 });
        assertAction(result, 'ADDRESS');
    });

    it('transfer() is an alias for send and returns action SEND', async () => {
        const result = await sdk.transfer({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'SEND');
    });

});
