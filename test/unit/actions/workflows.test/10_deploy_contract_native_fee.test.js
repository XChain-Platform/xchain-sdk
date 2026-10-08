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
const Workflows = require('../../../../src/actions/workflows.js');
const Actions = require('../../../../src/actions/index.js');
const Utility = require('../../../../src/utils/utility.js');
const config = require('../../../../src/config.js');
const feeMethods = require('../../../../src/XChainSDK/fees_and_services.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';
const FEE_DEST = 'Lfees7tszAx5Gqam2fuqf6biaX3LXafM4H';

// deployContract() must follow the registry-backed SDK fee decision or a DEPLOY on a
// native-fee chain goes out without its required output and is ruled invalid.
function makeSdk(coin, calls, quote) {
    const record = (kind) => async (params, enc) => {
    calls.push({ kind, params, enc });
    return { txid: kind + '_tx', indexed: { action_index: 3 } };
    };
    const session = {
    address: 'srcAddr',
    deploy: record('deploy'),
    deployChunk: record('chunk'),
    deposit: record('deposit'),
    };
    const sdk = {
    actions: new Actions({ config: config.getConfig(), util: new Utility() }),
    explorer: { coin },
    session: () => session,
    preflightContractLint: () => {},
    getAction: async () => ({ deployed_contract_index: 3 }),
    quoteNativeFee: sinon.spy(async () => quote),
    };
    session.sdk = sdk;
    sdk.nativeFeeRequired = feeMethods.nativeFeeRequired;
    sdk.nativeFeeOutputs = feeMethods.nativeFeeOutputs;
    return sdk;
}

const GOOD_QUOTE = { supported: true, valid: true, requiredFeeSats: 123456, feeDestination: FEE_DEST };

describe('Workflows deployContract() native fee output', function () {

    afterEach(() => sinon.restore());

    it('attaches the quoted fee output to the DEPLOY on LTC', async function () {
        const calls = [];
        const sdk = makeSdk('LTC', calls, GOOD_QUOTE);
        await new Workflows(sdk).deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].enc.customOutputs, [{ address: FEE_DEST, value: 123456 }]);
        assert.strictEqual(sdk.quoteNativeFee.firstCall.args[0].action, 'DEPLOY');
        assert.strictEqual(sdk.quoteNativeFee.firstCall.args[1].source, 'srcAddr');
    });

    it('attaches it on DOGE regtest', async function () {
        const calls = [];
        await new Workflows(makeSdk('RDOGE', calls, GOOD_QUOTE)).deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 });
        assert.strictEqual(calls[0].enc.customOutputs.length, 1);
    });

    it('attaches nothing on BTC and never asks for a quote', async function () {
        const calls = [];
        const sdk = makeSdk('BTC', calls, GOOD_QUOTE);
        await new Workflows(sdk).deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 });
        assert.deepStrictEqual(calls[0].enc, {});
        assert.strictEqual(sdk.quoteNativeFee.callCount, 0);
    });

    it('honours an explicit payFeeInNativeCoin on BTC', async function () {
        const calls = [];
        await new Workflows(makeSdk('BTC', calls, GOOD_QUOTE)).deployContract(FAKE_WIF,
            { code: 'x', gasLimit: 1 }, undefined, { payFeeInNativeCoin: true });
        assert.strictEqual(calls[0].enc.customOutputs.length, 1);
    });

    it('honours payFeeInNativeCoin:false on LTC', async function () {
        const calls = [];
        await new Workflows(makeSdk('LTC', calls, GOOD_QUOTE)).deployContract(FAKE_WIF,
            { code: 'x', gasLimit: 1 }, undefined, { payFeeInNativeCoin: false });
        assert.deepStrictEqual(calls[0].enc, {});
    });
});

describe('Workflows deployContract() native fee refusal and chunks', function () {

    afterEach(() => sinon.restore());

    it('refuses an unsupported quote before any DEPLOY is submitted', async function () {
        const calls = [];
        const wf = new Workflows(makeSdk('LTC', calls, { supported: false, error: 'no oracle' }));
        await assert.rejects(() => wf.deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 }),
            (e) => e.code === 'NATIVE_FEE_UNSUPPORTED');
        assert.strictEqual(calls.length, 0);
    });

    it('deploys without a fee output on an LTC node whose native fees are off', async function () {
        const calls = [];
        const off = { supported: false, valid: false, feeDestination: null, error: 'native coin fee not enabled' };
        await new Workflows(makeSdk('LTC', calls, off)).deployContract(FAKE_WIF, { code: 'x', gasLimit: 1 });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].enc, {});
    });

    it('pays the fee on every chunk carrier and the assembler', async function () {
        const calls = [];
        const code = 'a'.repeat(60000);
        await new Workflows(makeSdk('LTC', calls, GOOD_QUOTE)).deployContract(FAKE_WIF,
            { code, gasLimit: 1 });
        const chunks = calls.filter(c => c.kind === 'chunk');
        assert.ok(chunks.length > 1, 'source should chunk');
        for (const c of calls)
            assert.deepStrictEqual(c.enc.customOutputs, [{ address: FEE_DEST, value: 123456 }], c.kind);
        assert.strictEqual(calls[calls.length - 1].kind, 'deploy');
    });
});
