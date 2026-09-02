/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - Contract settle-gate tests
 *
 * A transaction being confirmed, and even its ACTION row being visible on the
 * explorer, is strictly earlier than the indexer EXECUTING that action against
 * the contract. A caller that settled in that gap got
 * bad-txns-inputs-missingorspent from the encoder (the deposit had already
 * spent its inputs) and a revert in the VM (the contract had not been credited
 * yet). These tests pin the gate that closes the window: the contract's OWN
 * state, and its balance for a DEPOSIT that writes no state key.
 *
 ********************************************************************/

'use strict';

const assert       = require('assert');
const sinon        = require('sinon');
const ActionWaiter = require('../../src/actionWaiter.js');

// The datatable envelope the explorer actually serves for
// /{COIN}/api/contract/{idx}/state, values as the JSON text it stores.
function stateEnvelope(pairs) {
    return {
        total: pairs.length,
        data:  pairs.map(([state_key, state_value], i) => ({
            id: i + 1, contract_index: 73, state_key,
            state_value: JSON.stringify(state_value), block_index: 900 + i
        }))
    };
}

function balanceEnvelope(rows) {
    return { total: rows.length, data: rows.map(([tick, quantity]) => ({ tick, quantity })) };
}

// A waiter over a scripted explorer: each call to getContractState /
// getContractBalance shifts the next scripted answer, and the last one repeats.
function makeWaiter(script) {
    const calls = { state: 0, balance: 0 };
    const next = (kind, list) => {
        const i = Math.min(calls[kind]++, list.length - 1);
        const answer = list[i];
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
    };
    const explorer = {
        getContractState:   async () => next('state', script.state || [null]),
        getContractBalance: async () => next('balance', script.balance || [null]),
    };
    const sdk = { ws: null, _requireExplorer: () => explorer };
    const waiter = new ActionWaiter(sdk);
    waiter._calls = calls;
    return waiter;
}


describe('ActionWaiter contract state gate', function () {

    describe('waitForContractState', function () {

        it('waits through the pre-execution reads and resolves when the key reaches the value', async function () {
            // Read 1 and 2 are the window the bug lived in: the transaction is
            // confirmed but the indexer has not executed the deposit, so the
            // contract has not gone FUNDED yet.
            const waiter = makeWaiter({ state: [
                stateEnvelope([]),
                stateEnvelope([['status', 'OPEN']]),
                stateEnvelope([['status', 'FUNDED'], ['seller', 'mrX']]),
            ]});
            const result = await waiter.waitForContractState(73,
                { key: 'status', equals: 'FUNDED', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.value, 'FUNDED');
            assert.strictEqual(result.contractActionIndex, 73);
            assert.strictEqual(result.state.seller, 'mrX');
            assert.strictEqual(waiter._calls.state, 3, 'it must not settle on the earlier reads');
        });

        it('compares against the PARSED value, not the quoted wire form', async function () {
            const waiter = makeWaiter({ state: [stateEnvelope([['status', 'FUNDED']])] });
            const result = await waiter.waitForContractState(73,
                { key: 'status', equals: 'FUNDED', timeout: 500, pollInterval: 5 });
            assert.strictEqual(result.value, 'FUNDED', 'the explorer serves "\\"FUNDED\\""');
        });

        it('matches a numeric state value written either way', async function () {
            const waiter = makeWaiter({ state: [stateEnvelope([['raised', 5000]])] });
            const result = await waiter.waitForContractState(73,
                { key: 'raised', equals: '5000', timeout: 500, pollInterval: 5 });
            assert.strictEqual(result.value, 5000);
        });

        it('accepts a predicate over the whole state map', async function () {
            const waiter = makeWaiter({ state: [
                stateEnvelope([['raised', 100]]),
                stateEnvelope([['raised', 900]]),
            ]});
            const result = await waiter.waitForContractState(73, {
                match: (state) => Number(state.raised) >= 500,
                timeout: 3000, pollInterval: 5
            });
            assert.strictEqual(result.state.raised, 900);
        });

        it('with a key alone, gates on the key EXISTING', async function () {
            const waiter = makeWaiter({ state: [
                stateEnvelope([]),
                stateEnvelope([['settled', true]]),
            ]});
            const result = await waiter.waitForContractState(73,
                { key: 'settled', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.value, true);
        });

        it('keeps polling through a read that throws (the contract 404s before it is indexed)', async function () {
            const waiter = makeWaiter({ state: [
                new Error('Request failed with status code 404'),
                stateEnvelope([['status', 'FUNDED']]),
            ]});
            const result = await waiter.waitForContractState(73,
                { key: 'status', equals: 'FUNDED', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.value, 'FUNDED');
        });

        it('rejects CONTRACT_STATE_TIMEOUT carrying the last state read', async function () {
            const waiter = makeWaiter({ state: [stateEnvelope([['status', 'OPEN']])] });
            try {
                await waiter.waitForContractState(73,
                    { key: 'status', equals: 'FUNDED', timeout: 60, pollInterval: 5 });
                assert.fail('a gate that never sees the state must not resolve');
            } catch (err) {
                assert.strictEqual(err.code, 'CONTRACT_STATE_TIMEOUT');
                assert.strictEqual(err.details.contractActionIndex, 73);
                assert.strictEqual(err.details.expected, 'FUNDED');
                assert.strictEqual(err.details.state.status, 'OPEN');
            }
        });

        it('settles on the first read when the state already holds', async function () {
            const waiter = makeWaiter({ state: [stateEnvelope([['status', 'FUNDED']])] });
            const result = await waiter.waitForContractState(73,
                { key: 'status', equals: 'FUNDED', timeout: 500, pollInterval: 5 });
            assert.strictEqual(result.value, 'FUNDED');
            assert.strictEqual(waiter._calls.state, 1);
        });

        it('refuses a condition-less wait, which would gate nothing', async function () {
            const waiter = makeWaiter({});
            try {
                await waiter.waitForContractState(73, { timeout: 100 });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_CONTRACT_STATE_CONDITION');
            }
        });

        it('refuses equals without a key to hold it', async function () {
            const waiter = makeWaiter({});
            try {
                await waiter.waitForContractState(73, { equals: 'FUNDED', timeout: 100 });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_CONTRACT_STATE_KEY');
            }
        });

        it('refuses a missing contract index', async function () {
            const waiter = makeWaiter({});
            try {
                await waiter.waitForContractState(undefined, { key: 'status', timeout: 100 });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_CONTRACT_INDEX');
            }
        });
    });

    describe('waitForContractBalance', function () {

        it('waits until the deposit is CREDITED, not until the tx is indexed', async function () {
            const waiter = makeWaiter({ balance: [
                balanceEnvelope([]),
                balanceEnvelope([['PAY514', '0']]),
                balanceEnvelope([['PAY514', '1000']]),
            ]});
            const result = await waiter.waitForContractBalance(73, 'PAY514',
                { minQuantity: '1000', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.quantity, '1000');
            assert.strictEqual(waiter._calls.balance, 3);
        });

        it('defaults to any quantity above zero', async function () {
            const waiter = makeWaiter({ balance: [
                balanceEnvelope([['PAY514', '0']]),
                balanceEnvelope([['PAY514', '0.00000001']]),
            ]});
            const result = await waiter.waitForContractBalance(73, 'PAY514',
                { timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.quantity, '0.00000001');
        });

        it('compares quantities in decimal, not as doubles', async function () {
            // Two quantities one unit apart, far above 2^53: as Numbers they are
            // the SAME value, so a Number comparison would settle a gate the
            // chain has not satisfied.
            const waiter = makeWaiter({ balance: [
                balanceEnvelope([['BIG', '90071992547409910']]),
                balanceEnvelope([['BIG', '90071992547409911']]),
            ]});
            const result = await waiter.waitForContractBalance(73, 'BIG',
                { minQuantity: '90071992547409911', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.quantity, '90071992547409911');
            assert.strictEqual(waiter._calls.balance, 2);
        });

        it('ignores another tick the contract happens to hold', async function () {
            const waiter = makeWaiter({ balance: [
                balanceEnvelope([['OTHER', '9000']]),
                balanceEnvelope([['OTHER', '9000'], ['PAY514', '10']]),
            ]});
            const result = await waiter.waitForContractBalance(73, 'PAY514',
                { minQuantity: '10', timeout: 3000, pollInterval: 5 });
            assert.strictEqual(result.quantity, '10');
        });

        it('rejects CONTRACT_BALANCE_TIMEOUT with the last quantity read', async function () {
            const waiter = makeWaiter({ balance: [balanceEnvelope([['PAY514', '10']])] });
            try {
                await waiter.waitForContractBalance(73, 'PAY514',
                    { minQuantity: '1000', timeout: 60, pollInterval: 5 });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'CONTRACT_BALANCE_TIMEOUT');
                assert.strictEqual(err.details.quantity, '10');
                assert.strictEqual(err.details.minQuantity, '1000');
            }
        });

        it('refuses a missing tick', async function () {
            const waiter = makeWaiter({});
            try {
                await waiter.waitForContractBalance(73, null, { timeout: 100 });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_TICK');
            }
        });
    });

    describe('state normalization', function () {

        it('unpacks the datatable envelope into a parsed map', function () {
            const state = ActionWaiter.normalizeContractState(
                stateEnvelope([['status', 'FUNDED'], ['raised', 42], ['open', false]]));
            assert.strictEqual(state.status, 'FUNDED');
            assert.strictEqual(state.raised, 42);
            assert.strictEqual(state.open, false);
        });

        it('accepts a bare row array', function () {
            const state = ActionWaiter.normalizeContractState([{ state_key: 'a', state_value: '"b"' }]);
            assert.strictEqual(state.a, 'b');
        });

        it('leaves an unparseable value as the raw string it already is', function () {
            const state = ActionWaiter.normalizeContractState([{ state_key: 'a', state_value: 'not json' }]);
            assert.strictEqual(state.a, 'not json');
        });

        it('carries a __proto__ state key as data instead of hitting the setter', function () {
            const state = ActionWaiter.normalizeContractState([{ state_key: '__proto__', state_value: '"x"' }]);
            assert.strictEqual(state.__proto__, 'x');
            assert.strictEqual(({}).polluted, undefined);
        });

        it('drops envelope fields when the response is already a key map', function () {
            const state = ActionWaiter.normalizeContractState({ total: 2, status: '"FUNDED"' });
            assert.strictEqual(state.status, 'FUNDED');
            assert.ok(!('total' in state));
        });

        it('reports a key that is not there as undefined, distinct from a null value', function () {
            const raw = stateEnvelope([['status', 'FUNDED']]);
            assert.strictEqual(ActionWaiter.readContractStateValue(raw, 'missing'), undefined);
            assert.strictEqual(ActionWaiter.readContractStateValue(
                [{ state_key: 'gone', state_value: null }], 'gone'), null);
        });

        it('reads a quantity as a STRING, never a lossy Number', function () {
            const q = ActionWaiter.readContractQuantity(
                balanceEnvelope([['BIG', '90071992547409911']]), 'BIG');
            assert.strictEqual(q, '90071992547409911');
            assert.strictEqual(ActionWaiter.readContractQuantity(balanceEnvelope([]), 'BIG'), null);
        });
    });
});
