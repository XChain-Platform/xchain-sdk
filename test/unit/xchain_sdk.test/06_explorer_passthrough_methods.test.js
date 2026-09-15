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

// Patch all explorer methods with a spy that resolves to {}
function mockExplorer(sdk, returnVal = {}) {
    const explorer = sdk.explorer;
    const proto = Object.getPrototypeOf(explorer);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof explorer[m] === 'function') {
            sinon.stub(explorer, m).resolves(returnVal);
        }
    }
    return explorer;
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

    // All these methods just call _requireExplorer().<method>(args)
    const explorerMethods = [
        { m: 'getBalances',           args: ['addr1', {}] },
        { m: 'getAddress',            args: ['addr1'] },
        { m: 'getHolders',            args: ['TOKEN', {}] },
        { m: 'getCredits',            args: ['addr1', 'address', {}] },
        { m: 'getDebits',             args: ['addr1', 'address', {}] },
        { m: 'getEscrows',            args: ['addr1', 'address', {}] },
        { m: 'getToken',              args: ['TOKEN'] },
        { m: 'findToken',             args: ['TOKEN'] },
        { m: 'tokenExists',           args: ['TOKEN'] },
        { m: 'getTokens',             args: ['addr1', 'address', {}] },
        { m: 'getIssues',             args: ['TOKEN', 'token', {}] },
        { m: 'getTransaction',        args: ['abc', 'tx_hash'] },
        { m: 'getAction',             args: [42] },
        { m: 'getBlock',              args: [100] },
        { m: 'getHistory',            args: ['addr1', 'address', {}] },
        { m: 'getAddresses',          args: ['addr1', 'address', {}] },
        { m: 'getAirdrops',           args: ['addr1', 'address', {}] },
        { m: 'getBatches',            args: ['addr1', 'address', {}] },
        { m: 'getBroadcasts',         args: ['addr1', 'address', {}] },
        { m: 'getCallbacks',          args: ['addr1', 'address', {}] },
        { m: 'getDestroys',           args: ['addr1', 'address', {}] },
        { m: 'getCoinpays',           args: ['addr1', 'address', {}] },
        { m: 'getCoinpayExpires',     args: ['addr1', 'address', {}] },
        { m: 'getCoinpayObligations', args: ['addr1', 'address', {}] },
        { m: 'getDispensers',         args: ['addr1', 'address', {}] },
        { m: 'getDispenses',          args: ['addr1', 'address', {}] },
        { m: 'getDividends',          args: ['addr1', 'address', {}] },
        { m: 'getFees',               args: ['addr1', 'address', {}] },
        { m: 'getFiles',              args: ['addr1', 'address', {}] },
        { m: 'getLinks',              args: ['addr1', 'address', {}] },
        { m: 'getLists',              args: ['addr1', 'address', {}] },
        { m: 'getMessages',           args: ['addr1', 'address', {}] },
        { m: 'getMints',              args: ['addr1', 'address', {}] },
        { m: 'getOrders',             args: ['addr1', 'address', {}] },
        { m: 'getSends',              args: ['addr1', 'address', {}] },
        { m: 'getSleeps',             args: ['addr1', 'address', {}] },
        { m: 'getSwaps',              args: ['addr1', 'address', {}] },
        { m: 'getSwapMatches',        args: ['100', 'block', {}] },
        { m: 'getSweeps',             args: ['addr1', 'address', {}] },
        { m: 'getContract',           args: [42] },
        { m: 'getContracts',          args: ['addr1', 'address', {}] },
        { m: 'getContractState',      args: [42, 'key'] },
        { m: 'getContractBalance',    args: [42, 'TOKEN'] },
        { m: 'getAttestations',       args: ['addr1', 'address', {}] },
        { m: 'getExecution',          args: [99] },
        { m: 'getExecutions',         args: [42, 'contract', {}] },
        { m: 'getDeposits',           args: ['addr1', 'address', {}] },
        { m: 'getWithdrawals',        args: ['addr1', 'address', {}] },
        { m: 'getStakes',             args: ['addr1', 'address', {}] },
        { m: 'getDelegations',        args: ['addr1', 'address', {}] },
        { m: 'getValidators',         args: [{}] },
        { m: 'getValidatorRewards',   args: ['addr1', 'address', {}] },
        { m: 'getMarkets',            args: ['TOKEN'] },
        { m: 'getMarket',             args: ['A', 'B'] },
        { m: 'getMarketHistory',      args: ['A', 'B', 'addr1', {}] },
        { m: 'getMarketOrders',       args: ['A', 'B', 'addr1', {}] },
        { m: 'getOrderbook',          args: ['A', 'B'] },
        { m: 'getStatus',             args: [] },
        { m: 'search',                args: ['q', 'token'] },
    ];

describe('XChainSDK', function () {
    registerEnvHooks();

    // Explorer passthrough methods

    describe('explorer passthrough methods', function () {

        let sdk;
        beforeEach(function () {
            sdk = makeSDK();
            mockExplorer(sdk, { total: 0, data: [] });
        });

        for (const { m, args } of explorerMethods) {
            it(m + '() delegates to explorer.' + m, async function () {
                await sdk[m](...args);
                expect(sdk.explorer[m].calledOnce).to.be.true;
            });
        }
    });
});
