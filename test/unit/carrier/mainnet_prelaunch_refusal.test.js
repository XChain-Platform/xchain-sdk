// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const XChainSDK = require('../../../src/XChainSDK.js');
const { SDKConfigError } = require('../../../src/utils/errors.js');
const { assertMainnetLaunched, isMainnetNetwork, MAINNET_LAUNCH_TIME } =
    require('../../../src/protocol/mainnet_launch.js');
const { makeSdk } = require('./lifecycle_manager.test/helpers/lifecycle_manager.js');

function registerLaunchRuleTests() {
    it('recognises only *-mainnet networks', function () {
        assert.strictEqual(isMainnetNetwork('bitcoin-mainnet'), true);
        assert.strictEqual(isMainnetNetwork('bitcoin-testnet'), false);
        assert.strictEqual(isMainnetNetwork(undefined), false);
    });

    it('refuses an action before launch with MAINNET_NOT_LAUNCHED', function () {
        assert.throws(
            () => assertMainnetLaunched('bitcoin-mainnet', { action: 'SEND' }, MAINNET_LAUNCH_TIME - 1),
            (e) => e instanceof SDKConfigError && e.code === 'MAINNET_NOT_LAUNCHED');
    });

    it('allows an action at the launch time', function () {
        assertMainnetLaunched('bitcoin-mainnet', { action: 'SEND' }, MAINNET_LAUNCH_TIME);
    });

    it('allows a payment-only submit and non-mainnet networks before launch', function () {
        assertMainnetLaunched('bitcoin-mainnet', {}, 0);
        assertMainnetLaunched('bitcoin-mainnet', undefined, 0);
        assertMainnetLaunched('bitcoin-testnet', { action: 'SEND' }, 0);
    });
}

function registerLifecycleTest() {
    it('submitAction refuses before any encoder call', async function () {
        sinon.stub(Date, 'now').returns((MAINNET_LAUNCH_TIME - 100) * 1000);
        const sdk = makeSdk();
        sdk.network = 'bitcoin-mainnet';
        const lm = new LifecycleManager(sdk);
        await assert.rejects(
            lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: 'x' }),
            (e) => e.code === 'MAINNET_NOT_LAUNCHED');
    });
}

function registerSdkTests() {
    it('refuses through a real SDK configured for mainnet', async function () {
        sinon.stub(Date, 'now').returns((MAINNET_LAUNCH_TIME - 100) * 1000);
        const sdk = new XChainSDK({
            network: 'bitcoin-mainnet',
            retry: false,
        });
        const createTx = sinon.stub(sdk.encoder, 'createTx').rejects(new Error('encoder called'));
        await assert.rejects(
            sdk.submitAction({ action: 'SEND', params: {} }, {}, { wif: 'x' }),
            (e) => e.code === 'MAINNET_NOT_LAUNCHED');
        assert.strictEqual(sdk.network, 'bitcoin-mainnet');
        assert.strictEqual(createTx.called, false);
    });

    it('refuses when mainnet comes from the environment and on the scoped UTXO path', async function () {
        const previous = process.env.NETWORK;
        process.env.NETWORK = 'bitcoin-mainnet';
        try {
            sinon.stub(Date, 'now').returns((MAINNET_LAUNCH_TIME - 100) * 1000);
            const sdk = new XChainSDK({
                retry: false,
            });
            await assert.rejects(
                sdk.submitAction({ action: 'SEND', params: {} }, { utxos: [{}] }, { wif: 'x' }),
                (e) => e.code === 'MAINNET_NOT_LAUNCHED');
            assert.strictEqual(sdk.network, 'bitcoin-mainnet');
        } finally {
            if (previous === undefined) delete process.env.NETWORK;
            else process.env.NETWORK = previous;
        }
    });
}

describe('mainnet prelaunch refusal', function () {
    afterEach(() => sinon.restore());
    registerLaunchRuleTests();
    registerLifecycleTest();
    registerSdkTests();
});
