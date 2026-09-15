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

const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../../src/XChainSDK.js');

// Helpers

// Env vars the SDK reads: clear them so tests are deterministic
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Build a minimal SDK pointed at a local regtest stack so no public
// defaults + no auto-hub are injected
function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        retry: false
    }, extra));
}

function registerEnvHooks() {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}

describe('XChainSDK', function () {
    registerEnvHooks();

    // ─── Action-shortcut methods → createAction({ action, params, encoder }) ──
    describe('action shortcut methods', function () {
        const SHORTCUTS = [
            ['send', 'SEND'], ['issue', 'ISSUE'], ['mint', 'MINT'], ['destroy', 'DESTROY'],
            ['order', 'ORDER'], ['transfer', 'SEND'], ['broadcast', 'BROADCAST'],
            ['dispenser', 'DISPENSER'], ['dividend', 'DIVIDEND'], ['sweep', 'SWEEP'],
            ['swap', 'SWAP'], ['callback', 'CALLBACK'], ['coinpay', 'COINPAY'], ['sleep', 'SLEEP'],
            ['airdrop', 'AIRDROP'], ['message', 'MESSAGE'], ['list', 'LIST'], ['link', 'LINK'],
            ['file', 'FILE'], ['address', 'ADDRESS'], ['stake', 'STAKE'], ['unstake', 'UNSTAKE'],
            ['delegate', 'DELEGATE'], ['collect', 'COLLECT'], ['deploy', 'DEPLOY'],
            ['execute', 'EXECUTE'], ['deposit', 'DEPOSIT'], ['withdraw', 'WITHDRAW'],
            ['price', 'PRICE'],
        ];

        let sdk, createStub;
        beforeEach(function () {
            sdk = makeSDK();
            // Stub the underlying action builder so no encoding/network is needed.
            createStub = sinon.stub(sdk.actions, 'createAction').returns({ actionString: 'OK' });
        });
        afterEach(function () { sinon.restore(); });

        for (const [method, action] of SHORTCUTS) {
            it(`sdk.${method}() builds a ${action} action`, async function () {
                const params = { k: 'v' };
                const result = await sdk[method](params);
                expect(createStub.calledOnce).to.equal(true);
                const arg = createStub.firstCall.args[0];
                expect(arg.action).to.equal(action);
                expect(arg.params).to.deep.equal(params);
                expect(result).to.deep.equal({ actionString: 'OK' });
            });
        }

        it('passes the encoder option through to createAction', async function () {
            const enc = { pubkey: undefined, fee: 10 };
            await sdk.send({ k: 'v' }, enc);
            expect(createStub.firstCall.args[0].encoder).to.equal(enc);
        });
    });
});
