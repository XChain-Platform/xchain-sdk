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

    describe('deploy pre-flight: constructor-params warning', function () {
        const SRC_WITH_INIT = 'module.exports = { initialize: function (a) { xchain.state.set("owner", a); }, run: function () { return "1"; } };';
        const SRC_NO_INIT   = 'module.exports = { run: function () { return "1"; } };';
        const CTOR_RE = /exports initialize\(\) but no CONSTRUCTOR_PARAMS/;

        function warned(spy, re) {
            return spy.getCalls().some(c => re.test(String(c.args[0])));
        }

        afterEach(function () { sinon.restore(); });

        it('getExportedMethodNames returns the exported callable surface, [] on unparseable', function () {
            const c = makeSDK().contracts;
            expect(c.getExportedMethodNames(SRC_WITH_INIT).sort()).to.deep.equal(['initialize', 'run']);
            expect(c.getExportedMethodNames(SRC_NO_INIT)).to.deep.equal(['run']);
            expect(c.getExportedMethodNames('function ( {')).to.deep.equal([]);
        });

        it('warns when the contract exports initialize() but no CONSTRUCTOR_PARAMS are provided', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
        });

        it('does not warn when CONSTRUCTOR_PARAMS are provided (UPPER or camelCase)', function () {
            const sdk = makeSDK();
            let spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: ['0xabc'] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
            spy.restore();
            spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, constructorParams: ['0xabc'] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('deploy pre-flight: constructor-params warning', function () {
        const SRC_WITH_INIT = 'module.exports = { initialize: function (a) { xchain.state.set("owner", a); }, run: function () { return "1"; } };';
        const SRC_NO_INIT   = 'module.exports = { run: function () { return "1"; } };';
        const CTOR_RE = /exports initialize\(\) but no CONSTRUCTOR_PARAMS/;

        function warned(spy, re) {
            return spy.getCalls().some(c => re.test(String(c.args[0])));
        }

        afterEach(function () { sinon.restore(); });

        it('treats an empty CONSTRUCTOR_PARAMS value ("" or []) as absent and still warns', function () {
            const sdk = makeSDK();
            let spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: '' }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
            spy.restore();
            spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: [] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
        });

        it('does not warn when the contract has no initialize export', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_NO_INIT }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
        });

        it('skips the warning entirely when lint is off', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT }, 'off');
            expect(spy.called).to.be.false;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('submitAction', function () {

        it('creates a LifecycleManager and delegates', async function () {
            const sdk = makeSDK();
            // Stub LifecycleManager
            const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
            const submitStub = sinon.stub().resolves({ txid: 'fake' });
            sinon.stub(LifecycleManager.prototype, 'submitAction').callsFake(submitStub);
            const result = await sdk.submitAction({ action: 'SEND', params: {} }, { pubkey: 'pub' }, {});
            expect(submitStub.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('validateAction', function () {
        it('delegates to actions.validateAction', function () {
            const sdk = makeSDK();
            const result = sdk.validateAction('SEND', { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' });
            expect(result).to.be.an('object');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('getActions / getActionFormats / getActionFields', function () {
        it('getActions returns list of supported actions', function () {
            const sdk = makeSDK();
            const result = sdk.getActions();
            expect(result).to.be.an('array');
            expect(result.length).to.be.greaterThan(0);
        });

        it('getActionFormats returns formats for SEND', function () {
            const sdk = makeSDK();
            const result = sdk.getActionFormats('SEND');
            expect(result).to.be.ok;
        });

        it('getActionFields returns fields for SEND', function () {
            const sdk = makeSDK();
            const result = sdk.getActionFields('SEND');
            expect(result).to.be.ok;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // Convenience action methods (all delegate to createAction)

    describe('convenience action methods', function () {
        const methods = [
            ['send', 'SEND'], ['issue', 'ISSUE'], ['mint', 'MINT'],
            ['destroy', 'DESTROY'], ['order', 'ORDER'], ['transfer', 'SEND'],
            ['broadcast', 'BROADCAST'], ['dispenser', 'DISPENSER'],
            ['dividend', 'DIVIDEND'], ['sweep', 'SWEEP'], ['swap', 'SWAP'],
            ['callback', 'CALLBACK'], ['coinpay', 'COINPAY'], ['sleep', 'SLEEP'],
            ['airdrop', 'AIRDROP'], ['message', 'MESSAGE'], ['list', 'LIST'],
            ['link', 'LINK'], ['file', 'FILE'], ['address', 'ADDRESS'],
            ['stake', 'STAKE'], ['unstake', 'UNSTAKE'], ['delegate', 'DELEGATE'],
            ['collect', 'COLLECT'], ['deploy', 'DEPLOY'], ['execute', 'EXECUTE'],
            ['deposit', 'DEPOSIT'], ['withdraw', 'WITHDRAW']
        ];

        for (const [method, action] of methods) {
            it(method + '() calls createAction with action=' + action, async function () {
                const sdk = makeSDK();
                const spy = sinon.stub(sdk, 'createAction').resolves({ actionString: action + '|...' });
                await sdk[method]({}, undefined);
                expect(spy.calledOnce).to.be.true;
                expect(spy.firstCall.args[0].action).to.equal(action);
            });
        }
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // contract() / session() / batch()

    describe('contract()', function () {
        it('returns a ContractClient instance', function () {
            const sdk = makeSDK();
            const ContractClient = require('../../../src/contract/client.js');
            const cc = sdk.contract(42);
            expect(cc).to.be.instanceOf(ContractClient);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('controller (programmable policy)', function () {
        it('exposes sdk.controller as a ControllerHelpers instance', function () {
            const sdk = makeSDK();
            const ControllerHelpers = require('../../../src/actions/controller.js');
            expect(sdk.controller).to.be.instanceOf(ControllerHelpers);
        });
        it('getContractManifest delegates to the explorer reader', async function () {
            const sdk = makeSDK();
            sinon.stub(sdk.explorer, 'getContractManifest').resolves({ permissions: ['SEND'], maxTakeBps: 250 });
            const m = await sdk.getContractManifest(42);
            expect(m).to.deep.equal({ permissions: ['SEND'], maxTakeBps: 250 });
            expect(sdk.explorer.getContractManifest.calledWith(42)).to.equal(true);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('session()', function () {
        it('returns a WalletSession instance', function () {
            const sdk = makeSDK();
            const WalletSession = require('../../../src/utils/wallet_session.js');
            // Use a valid WIF for regtest
            const kp = sdk.wallet.generateKeyPair();
            const session = sdk.session(kp.wif, {});
            expect(session).to.be.instanceOf(WalletSession);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('batch()', function () {
        it('returns a BatchBuilder', function () {
            const sdk = makeSDK();
            const BatchBuilder = require('../../../src/carrier/batch_builder.js');
            const b = sdk.batch();
            expect(b).to.be.instanceOf(BatchBuilder);
        });

        it('carries a deploy() convenience beside the other VM actions', function () {
            // DEPLOY had no convenience method while the SDK banned it from a
            // BATCH outright. The chain caps it at 1, so the method exists and
            // the queue accepts it like any other VM action.
            const b = makeSDK().batch();
            expect(b.deploy).to.be.a('function');
            expect(b.deploy({ code_encoding: 'x', gas_limit: '1' })).to.equal(b);
            expect(b.length).to.equal(1);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // Workflow methods

    describe('workflow methods', function () {
        const workflowMethods = [
            'issueAndDistribute', 'issueAndMint', 'createDispenser',
            'createOrder', 'cancelOrder', 'stakeAndDelegate',
            'deployAndFund', 'distributeDividend'
        ];

        for (const method of workflowMethods) {
            it(method + '() delegates to workflows.' + method, async function () {
                const sdk = makeSDK();
                sinon.stub(sdk.workflows, method).resolves({ success: true });
                const result = await sdk[method]('wif', {}, {});
                expect(sdk.workflows[method].calledOnce).to.be.true;
            });
        }
    });
});
