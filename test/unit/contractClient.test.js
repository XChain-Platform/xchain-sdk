// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const ContractClient = require('../../src/contractClient.js');

// Build a minimal stub SDK with injected collaborators
function makeSdk(overrides = {}) {
    let explorer = {
        getContract:       async (idx) => ({ action_index: idx, tick: 'MYCON', source: 'addr1' }),
        getContractState:  async (idx, key) => key ? { value: 'stateVal' } : { key1: 'v1' },
        getExecutions:     async (idx, type, opts) => ({ total: 2, data: [{ method: 'run' }] }),
        getContractBalance: async (idx, tick) => tick ? { tick, quantity: '1000' } : [{ tick: 'TOK', quantity: '500' }],
        getContractManifest: async (idx) => ({ permissions: ['SEND'], maxTakeBps: 250 }),
        ...overrides.explorer
    };
    return {
        execute:  async (params, encoder) => ({ submitted: true, params }),
        deposit:  async (params, encoder) => ({ submitted: true, params }),
        withdraw: async (params, encoder) => ({ submitted: true, params }),
        _requireExplorer: () => explorer,
        ...overrides
    };
}

describe('ContractClient', function () {

    describe('constructor', function () {
        it('stores sdk and contractActionIndex', function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 42);
            assert.strictEqual(client.contractActionIndex, 42);
            assert.strictEqual(client.sdk, sdk);
            assert.strictEqual(client._info, null);
        });

        it('coerces contractActionIndex to number', function () {
            let client = new ContractClient(makeSdk(), '99');
            assert.strictEqual(client.contractActionIndex, 99);
        });

        it('accepts contractActionIndex of 0', function () {
            let client = new ContractClient(makeSdk(), 0);
            assert.strictEqual(client.contractActionIndex, 0);
        });

        it('throws SDKContractError when contractActionIndex is missing', function () {
            try {
                new ContractClient(makeSdk());
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
                assert.strictEqual(e.code, 'INVALID_CONTRACT_INDEX');
            }
        });

        it('throws SDKContractError when contractActionIndex is null', function () {
            try {
                new ContractClient(makeSdk(), null);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKContractError');
            }
        });
    });

    describe('call()', function () {
        it('delegates to sdk.execute with correct params', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 7);
            let result = await client.call('run', [1, 2], {});
            assert.strictEqual(result.submitted, true);
            assert.strictEqual(result.params.contractActionIndex, 7);
            assert.strictEqual(result.params.method, 'run');
            assert.deepStrictEqual(result.params.params, [1, 2]);
        });

        it('defaults params to [] when not provided', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 3);
            let result = await client.call('noop');
            assert.deepStrictEqual(result.params.params, []);
        });
    });

    describe('deposit()', function () {
        it('delegates to sdk.deposit with correct params', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 5);
            let result = await client.deposit('TOKEN', '100', {});
            assert.strictEqual(result.submitted, true);
            assert.strictEqual(result.params.contractActionIndex, 5);
            assert.strictEqual(result.params.tick, 'TOKEN');
            assert.strictEqual(result.params.quantity, '100');
        });
    });

    describe('withdraw()', function () {
        it('delegates to sdk.withdraw with correct params', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 8);
            let result = await client.withdraw('TOKEN', '50', {});
            assert.strictEqual(result.submitted, true);
            assert.strictEqual(result.params.contractActionIndex, 8);
            assert.strictEqual(result.params.tick, 'TOKEN');
            assert.strictEqual(result.params.quantity, '50');
        });
    });

    describe('getInfo()', function () {
        it('fetches and caches contract info', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 42);
            let info = await client.getInfo();
            assert.strictEqual(info.action_index, 42);
            // cached
            assert.strictEqual(client._info, info);
        });

        it('calls explorer.getContract with contractActionIndex', async function () {
            let capturedIdx;
            let sdk = makeSdk({
                explorer: {
                    getContract: async (idx) => { capturedIdx = idx; return { action_index: idx }; }
                }
            });
            let client = new ContractClient(sdk, 13);
            await client.getInfo();
            assert.strictEqual(capturedIdx, 13);
        });
    });

    describe('getState()', function () {
        it('returns state for a specific key', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 1);
            let result = await client.getState('mykey');
            assert.deepStrictEqual(result, { value: 'stateVal' });
        });

        it('returns all state when no key given', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 1);
            let result = await client.getState();
            assert.deepStrictEqual(result, { key1: 'v1' });
        });
    });

    // The settle gate: a caller holding a bound client asks the CONTRACT
    // whether the action executed, never the transaction whether it confirmed.
    describe('waitForState() / waitForBalance()', function () {
        it('waitForState delegates to the SDK gate, bound to this contract', async function () {
            let seen = null;
            let sdk = makeSdk({
                waitForContractState: async (idx, opts) => { seen = { idx, opts }; return { value: 'FUNDED' }; }
            });
            let client = new ContractClient(sdk, 73);
            let result = await client.waitForState({ key: 'status', equals: 'FUNDED' });
            assert.strictEqual(result.value, 'FUNDED');
            assert.strictEqual(seen.idx, 73);
            assert.strictEqual(seen.opts.equals, 'FUNDED');
        });

        it('waitForBalance delegates with the tick', async function () {
            let seen = null;
            let sdk = makeSdk({
                waitForContractBalance: async (idx, tick, opts) => { seen = { idx, tick, opts }; return { quantity: '1000' }; }
            });
            let client = new ContractClient(sdk, 73);
            let result = await client.waitForBalance('PAY514', { minQuantity: '1000' });
            assert.strictEqual(result.quantity, '1000');
            assert.strictEqual(seen.idx, 73);
            assert.strictEqual(seen.tick, 'PAY514');
            assert.strictEqual(seen.opts.minQuantity, '1000');
        });
    });

    describe('getExecutions()', function () {
        it('returns execution history', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 1);
            let result = await client.getExecutions({ page: 1 });
            assert.strictEqual(result.total, 2);
            assert.strictEqual(result.data[0].method, 'run');
        });
    });

    describe('getBalance()', function () {
        it('returns balance for a specific tick', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 1);
            let result = await client.getBalance('TOK');
            assert.strictEqual(result.tick, 'TOK');
            assert.strictEqual(result.quantity, '1000');
        });

        it('returns all balances when no tick given', async function () {
            let sdk = makeSdk();
            let client = new ContractClient(sdk, 1);
            let result = await client.getBalance();
            assert.ok(Array.isArray(result));
            assert.strictEqual(result[0].tick, 'TOK');
        });
    });

    describe('getManifest()', function () {
        it('delegates to explorer.getContractManifest with the bound index', async function () {
            let capturedIdx;
            let sdk = makeSdk({
                explorer: {
                    getContractManifest: async (idx) => { capturedIdx = idx; return { permissions: ['MINT'], maxTakeBps: 100 }; }
                }
            });
            let client = new ContractClient(sdk, 17);
            let m = await client.getManifest();
            assert.strictEqual(capturedIdx, 17);
            assert.deepStrictEqual(m, { permissions: ['MINT'], maxTakeBps: 100 });
        });
    });

    describe('parseManifest()', function () {
        it('parses a permissions JSON string and numeric max_take_bps', function () {
            assert.deepStrictEqual(
                ContractClient.parseManifest({ permissions: '["SEND","MINT"]', max_take_bps: 300 }),
                { permissions: ['SEND', 'MINT'], maxTakeBps: 300 }
            );
        });
        it('passes through an already-parsed array', function () {
            assert.deepStrictEqual(
                ContractClient.parseManifest({ permissions: ['SEND'], max_take_bps: null }),
                { permissions: ['SEND'], maxTakeBps: null }
            );
        });
        it('returns nulls for a manifest-less contract', function () {
            assert.deepStrictEqual(ContractClient.parseManifest({}), { permissions: null, maxTakeBps: null });
        });
        it('returns nulls for null input', function () {
            assert.deepStrictEqual(ContractClient.parseManifest(null), { permissions: null, maxTakeBps: null });
        });
        it('treats unparseable permissions as null (no throw)', function () {
            assert.deepStrictEqual(
                ContractClient.parseManifest({ permissions: 'not-json', max_take_bps: '' }),
                { permissions: null, maxTakeBps: null }
            );
        });
    });

});
