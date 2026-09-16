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
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const ActionWaiter = require('../../../../src/utils/action_waiter.js');
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

/*
 *  Contract settle gate
 *
 *  The explorer exposes a transaction's ACTION rows as soon as the decoder
 *  writes them, which is BEFORE the indexer executes them against the
 *  contract. A caller that settled on that read spent inputs its own
 *  pending deposit had already used (bad-txns-inputs-missingorspent from
 *  the encoder) and, where it landed at all, reverted in the VM against a
 *  contract that had not been credited. These pin the two gates that close
 *  the window.
 */

// A fake SDK whose createAction reports the contract action under test.
function contractSdk(action, explorer) {
    const sdk = makeSdk({
        _requireExplorer: () => explorer,
    });
    sdk.actions = {
        createAction: () => ({ actionString: 'XCHAIN|' + action + '|...', action, version: 1 }),
    };
    return sdk;
}

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): contract actions", function () {
        it('defaults strictStatus ON for DEPOSIT, EXECUTE and WITHDRAW', async function () {
            for (const action of ['DEPOSIT', 'EXECUTE', 'WITHDRAW']) {
                const waiterStub = sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
                const lm = new LifecycleManager(contractSdk(action, {}));
                await lm.submitAction({ action, params: { contractActionIndex: 73 } }, {}, { wif: FAKE_WIF });
                assert.strictEqual(waiterStub.firstCall.args[1].strictStatus, true,
                    action + ': a status the indexer never wrote is not evidence the contract executed');
                sinon.restore();
            }
        });

        it('leaves strictStatus OFF for an ordinary action', async function () {
            const waiterStub = sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const lm = new LifecycleManager(makeSdk());
            await lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: FAKE_WIF });
            assert.strictEqual(waiterStub.firstCall.args[1].strictStatus, false);
        });

        it('honours an explicit strictStatus:false on a contract action', async function () {
            const waiterStub = sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const lm = new LifecycleManager(contractSdk('DEPOSIT', {}));
            await lm.submitAction({ action: 'DEPOSIT', params: { contractActionIndex: 73 } }, {},
                { wif: FAKE_WIF, strictStatus: false });
            assert.strictEqual(waiterStub.firstCall.args[1].strictStatus, false);
        });

        it('gates on the contract state and reports it on the result', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            let reads = 0;
            const explorer = {
                // The contract goes FUNDED only on the third read: the two before
                // it are the window in which a settling caller can return early.
                getContractState: async () => ({ total: 1, data: [
                    { state_key: 'status', state_value: JSON.stringify(++reads < 3 ? 'OPEN' : 'FUNDED') }
                ]}),
            };
            const lm = new LifecycleManager(contractSdk('EXECUTE', explorer));
            const steps = [];
            const result = await lm.submitAction(
                { action: 'EXECUTE', params: { contractActionIndex: 73 } }, {},
                { wif: FAKE_WIF, onProgress: (s) => steps.push(s),
                  awaitContract: { key: 'status', equals: 'FUNDED', timeout: 3000, pollInterval: 5 } }
            );
            assert.strictEqual(result.contractState.value, 'FUNDED');
            assert.strictEqual(result.contractState.contractActionIndex, 73,
                'the gate defaults to the contract the action itself targets');
            assert.strictEqual(reads, 3);
            assert.ok(steps.includes('waiting_contract_state'));
            assert.ok(steps.includes('contract_settled'));
        });
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): contract actions", function () {
        it('gates on the contract BALANCE for a deposit that writes no state key', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            let reads = 0;
            const explorer = {
                getContractBalance: async () => (++reads < 2)
                    ? { total: 0, data: [] }
                    : { total: 1, data: [{ tick: 'PAY514', quantity: '1000' }] },
            };
            const lm = new LifecycleManager(contractSdk('DEPOSIT', explorer));
            const result = await lm.submitAction(
                { action: 'DEPOSIT', params: { contractActionIndex: 73, tick: 'PAY514', quantity: '1000' } }, {},
                { wif: FAKE_WIF,
                  awaitContract: { tick: 'PAY514', minQuantity: '1000', timeout: 3000, pollInterval: 5 } }
            );
            assert.strictEqual(result.contractBalance.quantity, '1000');
            assert.strictEqual(reads, 2, 'the empty read must not settle the gate');
        });

        it('reads the contract index off the upper-case wire form too', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const explorer = {
                getContractState: async () => ({ total: 1, data: [
                    { state_key: 'status', state_value: '"FUNDED"' }] }),
            };
            const lm = new LifecycleManager(contractSdk('EXECUTE', explorer));
            const result = await lm.submitAction(
                { action: 'EXECUTE', params: { CONTRACT_ACTION_INDEX: 91 } }, {},
                { wif: FAKE_WIF, awaitContract: { key: 'status', equals: 'FUNDED', timeout: 1000, pollInterval: 5 } }
            );
            assert.strictEqual(result.contractState.contractActionIndex, 91);
        });
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): contract actions", function () {
        it('marks a gate timeout as broadcast so the caller does not rebuild and double-spend', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const explorer = {
                getContractState: async () => ({ total: 1, data: [
                    { state_key: 'status', state_value: '"OPEN"' }] }),
            };
            const lm = new LifecycleManager(contractSdk('EXECUTE', explorer));
            try {
                await lm.submitAction({ action: 'EXECUTE', params: { contractActionIndex: 73 } }, {},
                    { wif: FAKE_WIF, awaitContract: { key: 'status', equals: 'FUNDED', timeout: 60, pollInterval: 5 } });
                assert.fail('a gate that never sees the state must not resolve');
            } catch (err) {
                assert.strictEqual(err.code, 'CONTRACT_STATE_TIMEOUT');
                assert.strictEqual(err.broadcast, true);
                assert.ok(err.txid);
                assert.strictEqual(err.details.broadcast, true);
            }
        });

        it('refuses a gate with no contract to read', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const lm = new LifecycleManager(contractSdk('EXECUTE', {}));
            try {
                await lm.submitAction({ action: 'EXECUTE', params: {} }, {},
                    { wif: FAKE_WIF, awaitContract: { key: 'status', equals: 'FUNDED' } });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_CONTRACT_INDEX');
            }
        });
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): contract actions", function () {
        // The regression itself, end to end through the REAL waiter: a deposit
        // must not hand control back before the contract holds the tokens.
        it('does not return a deposit until the contract is credited', async function () {
            const txid = 'aa'.repeat(32);
            const order = [];
            let statusReads = 0;
            let credited = false;
            const explorer = {
                // The decoder's rows land first, with no indexer status on them.
                getTransaction: async () => {
                    let indexed = ++statusReads >= 3;
                    if (indexed) credited = true;             // the same indexer pass credits the contract
                    order.push(indexed ? 'action-status' : 'tx-confirmed');
                    return { tx_hash: txid, block_index: 4200,
                             actions: [{ action: 'DEPOSIT', action_index: 5, status: indexed ? 'valid' : null }] };
                },
                getContractBalance: async () => {
                    order.push('balance-read');
                    return credited
                        ? { total: 1, data: [{ tick: 'PAY514', quantity: '1000' }] }
                        : { total: 0, data: [] };
                },
            };
            const lm = new LifecycleManager(contractSdk('DEPOSIT', explorer));
            const result = await lm.submitAction(
                { action: 'DEPOSIT', params: { contractActionIndex: 73, tick: 'PAY514', quantity: '1000' } }, {},
                { wif: FAKE_WIF, timeout: 4000, pollInterval: 20,
                  awaitContract: { tick: 'PAY514', minQuantity: '1000', timeout: 3000, pollInterval: 20 } }
            );

            assert.strictEqual(result.contractBalance.quantity, '1000');
            assert.ok(order.indexOf('tx-confirmed') >= 0, 'the early confirmed reads happened');
            assert.ok(order.indexOf('balance-read') > order.indexOf('action-status'),
                'the balance is only read once the action carries an indexer status');
            assert.ok(statusReads >= 3, 'a status-less action row must not settle the wait');
        });
    });
});
