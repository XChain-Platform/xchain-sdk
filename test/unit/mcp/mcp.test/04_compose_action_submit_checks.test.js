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
 * compose_action runs the steps submit_action runs before the encoder is
 * contacted: the halt-class gate, and on a native-fee chain the quoted fee
 * output handed to the encoder as customOutputs.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = require('../../../../mcp/server.js');
const XChainSDK = require('../../../../src/XChainSDK.js');
const coins = require('../../../../src/coins');

function composeStub(network, overrides) {
    const calls = [];
    return Object.assign({
        network, calls,
        createAction: async () => ({ actionString: 'SEND|0|TOK|5|dest' }),
        encodeTx: async (params) => { calls.push(['encodeTx', params]); return { psbt: 'beef', encoding: 'OP_RETURN' }; },
    }, overrides || {});
}

async function connectWith(sdkFactory) {
    const server = buildServer({ sdkFactory });
    const client = new Client({ name: 'compose', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
}

const compose = (client, args) => client.callTool({
    name: 'compose_action',
    arguments: Object.assign({ coin: 'RLTC', action: 'send', params: { tick: 'TOK', amount: '5' }, pubkey: 'senderaddr' }, args || {}),
});

describe('MCP compose_action runs the submit-path checks before the encoder', () => {

    it('sizes the native fee output for the sender and hands it to the encoder', async () => {
        const FEE = [{ address: 'feeaddr', value: 1234 }];
        const made = [];
        const client = await connectWith((network) => {
            const s = composeStub(network, { nativeFeeOutputs: async (actionString, opts) => { s.calls.push(['nativeFeeOutputs', actionString, opts]); return FEE; } });
            made.push(s);
            return s;
        });
        const res = await compose(client);
        expect(res.isError, JSON.stringify(res.content)).to.not.equal(true);
        const calls = made[0].calls;
        expect(calls.find((c) => c[0] === 'nativeFeeOutputs').slice(1))
            .to.deep.equal(['SEND|0|TOK|5|dest', { source: 'senderaddr' }]);
        expect(calls.find((c) => c[0] === 'encodeTx')[1])
            .to.deep.equal({ pubkey: 'senderaddr', data: 'SEND|0|TOK|5|dest', customOutputs: FEE });
    });

    it('sends the quoted FEE_DESTINATION output to create_tx on a native-fee chain (real SDK)', async () => {
        const destination = coins.getCoinConfig('LTC', 'mainnet').addresses.FEE_DESTINATION;
        let sdk;
        const client = await connectWith((network) => {
            sdk = new XChainSDK({ network, explorerUrl: 'explorer.test', explorerPort: 8080,
                encoderUrl: 'http://encoder.test:3000', retry: false });
            sinon.stub(sdk, 'quoteNativeFee').resolves({ supported: true, valid: true, requiredFeeSats: 4321,
                requiredFeeSatsExact: '4321', feeDestination: destination });
            sinon.stub(sdk.encoder, 'createTx').resolves({ psbt: 'beef', encoding: 'OP_RETURN' });
            return sdk;
        });
        try {
            const res = await compose(client, { coin: 'LTC', params: { tick: 'TOK', amount: '5', destination } });
            const sent = sdk.encoder.createTx.firstCall && sdk.encoder.createTx.firstCall.args[0];
            expect(res.isError, JSON.stringify(res.content)).to.not.equal(true);
            expect(sent.customOutputs).to.deep.equal([{ address: destination, value: 4321 }]);
            expect(sdk.quoteNativeFee.firstCall.args[1].source).to.equal('senderaddr');
        } finally { sinon.restore(); }
    });

    it('reserves nothing when the native fee quote is refused', async () => {
        const made = [];
        const client = await connectWith((network) => {
            const s = composeStub(network, { nativeFeeOutputs: async () => { throw new Error('quote refused'); } });
            made.push(s);
            return s;
        });
        const res = await compose(client);
        expect(res.isError).to.equal(true);
        expect(made[0].calls.some((c) => c[0] === 'encodeTx')).to.equal(false);
    });

    it('refuses a halt-class action before the encoder is contacted', async () => {
        const HALT = 'DISPENSER|0||JDOG|1|||RBTC||1|||||0x10|||';
        const made = [];
        const client = await connectWith((network) => {
            const s = composeStub(network, { createAction: async () => ({ actionString: HALT }) });
            made.push(s);
            return s;
        });
        const res = await compose(client, { coin: 'RBTC', action: 'dispenser', params: {} });
        expect(res.isError).to.equal(true);
        expect(JSON.stringify(res.content)).to.contain('EXPIRATION');
        expect(made[0].calls.some((c) => c[0] === 'encodeTx')).to.equal(false);
    });

    it('composes unchanged when the SDK carries no halt gate static', async () => {
        const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
        const HALT = 'DISPENSER|0||JDOG|1|||RBTC||1|||||0x10|||';
        const gate = LifecycleManager.assertNoHaltClassFields;
        delete LifecycleManager.assertNoHaltClassFields;
        try {
            const made = [];
            const client = await connectWith((network) => {
                const s = composeStub(network, { createAction: async () => ({ actionString: HALT }) });
                made.push(s);
                return s;
            });
            const res = await compose(client, { coin: 'RBTC', action: 'dispenser', params: {} });
            expect(res.isError, JSON.stringify(res.content)).to.not.equal(true);
            expect(made[0].calls.some((c) => c[0] === 'encodeTx')).to.equal(true);
        } finally { LifecycleManager.assertNoHaltClassFields = gate; }
    });
});
