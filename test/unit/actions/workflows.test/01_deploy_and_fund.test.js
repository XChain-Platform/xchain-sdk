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

// Helpers

/**
 * Build a minimal fake SDK whose sdk.session() returns a stubbed WalletSession.
 * `sessionMethods` lets individual tests override what each session method returns.
 */
function makeSdk(sessionMethods = {}) {
    const defaults = {
        issue:             async () => ({ txid: 'issue_tx', indexed: { action_index: 42 } }),
        mint:              async () => ({ txid: 'mint_tx' }),
        send:              async () => ({ txid: 'send_tx' }),
        dispenser:         async () => ({ txid: 'dispenser_tx' }),
        order:             async () => ({ txid: 'order_tx' }),
        stake:             async () => ({ txid: 'stake_tx' }),
        delegate:          async () => ({ txid: 'delegate_tx' }),
        stakeToContract:   async () => ({ txid: 'stake_contract_tx' }),
        delegateForContract: async () => ({ txid: 'delegate_contract_tx' }),
        deploy:            async () => ({ txid: 'deploy_tx', indexed: { action_index: 99 } }),
        deposit:           async () => ({ txid: 'deposit_tx' }),
        dividend:          async () => ({ txid: 'dividend_tx' }),
    };
    const sessionFns = Object.assign({}, defaults, sessionMethods);
    return {
        session: () => sessionFns,
        // The explorer read the chunked-deploy resolution polls. Answers the
        // sequential shape (the assembler's own index) unless a test overrides it.
        getAction: async (actionIndex) => ({ data: [{ action_index: actionIndex, deployed_contract_index: actionIndex, assembly_status: 'valid' }] }),
    };
}

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';
const FAKE_TICK = 'TOKEN';

// Tests

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // deployAndFund()
    describe('deployAndFund()', function () {
        it('deploys with no deposits: returns empty deposits array', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x', gasLimit: 1000 }, []);
            assert.strictEqual(result.deploy.txid, 'deploy_tx');
            assert.deepStrictEqual(result.deposits, []);
        });

        it('deploys with null deposits: returns empty deposits array', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x' }, null);
            assert.deepStrictEqual(result.deposits, []);
        });

        it('deploys and deposits when deposits provided + deploy has action_index', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const deposits = [
                { tick: 'A', quantity: '100' },
                { tick: 'B', quantity: '200' },
            ];
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x' }, deposits);
            assert.strictEqual(result.deploy.txid, 'deploy_tx');
            assert.strictEqual(result.deposits.length, 2);
            assert.strictEqual(result.deposits[0].txid, 'deposit_tx');
        });

        // Was "skips deposits when ...". A caller that asked for deposits and got a
        // SUCCESS carrying none had been told the contract is funded when it is not,
        // and the sibling flows (attachContent, setRoster) already refuse instead of
        // skipping. The broadcast deploy is not lost: withPartial returns it.
        it('refuses to fund when deploy indexed has no action_index (null), keeping the deploy', async function () {
            const sdk = makeSdk({
                deploy: async () => ({ txid: 'deploy', indexed: null })
            });
            const wf = new Workflows(sdk);
            let err;
            try {
                await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [{ tick: 'A', quantity: '10' }]);
            } catch (e) { err = e; }
            assert.ok(err, 'an unfunded contract must not look like success');
            assert.match(err.message, /action_index unavailable/);
            assert.strictEqual(err.partial.deploy.txid, 'deploy');
            assert.deepStrictEqual(err.partial.deposits, []);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployAndFund()', function () {
        // The defect: the POLLING waiter resolves a whole transaction, so reading
        // indexed.action_index directly saw undefined, which passed a `!== null`
        // guard and sent a DEPOSIT carrying no contract reference at all.
        it('funds from the polling waiter shape ({ actions: [...] })', async function () {
            const depositCalls = [];
            const sdk = makeSdk({
                deploy:  async () => ({ txid: 'deploy_tx', indexed: { actions: [{ action_index: 99 }] } }),
                deposit: async (p) => { depositCalls.push(p); return { txid: 'dep' }; }
            });
            const wf = new Workflows(sdk);
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [{ tick: 'TOK', quantity: '50' }]);
            assert.strictEqual(result.deposits.length, 1);
            assert.strictEqual(depositCalls[0].contractActionIndex, 99);
        });

        it('funds on action_index 0, which is a valid index and not a missing one', async function () {
            const depositCalls = [];
            const sdk = makeSdk({
                deploy:  async () => ({ txid: 'deploy_tx', indexed: { action_index: 0 } }),
                deposit: async (p) => { depositCalls.push(p); return { txid: 'dep' }; }
            });
            const wf = new Workflows(sdk);
            await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [{ tick: 'TOK', quantity: '1' }]);
            assert.strictEqual(depositCalls[0].contractActionIndex, 0);
        });

        it('on a deposit failure, attaches the already-broadcast deploy to the error', async function () {
            let calls = 0;
            const sdk = makeSdk({
                deposit: async () => { calls++; if (calls === 2) throw new Error('deposit failed'); return { txid: 'deposit_tx_' + calls }; }
            });
            const wf = new Workflows(sdk);
            let err;
            try {
                await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [
                    { tick: 'A', quantity: '1' }, { tick: 'B', quantity: '2' }
                ]);
            } catch (e) { err = e; }
            assert.ok(err && err.partial, 'error must carry partial results');
            assert.strictEqual(err.partial.deploy.txid, 'deploy_tx');   // DEPLOY not lost
            assert.strictEqual(err.partial.deposits.length, 1);         // first deposit not lost
            assert.strictEqual(err.partial.deposits[0].txid, 'deposit_tx_1');
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('deployAndFund()', function () {
        it('refuses to fund when the deploy result has no indexed field at all', async function () {
            const sdk = makeSdk({
                deploy: async () => ({ txid: 'deploy' })
            });
            const wf = new Workflows(sdk);
            let err;
            try {
                await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [{ tick: 'A', quantity: '10' }]);
            } catch (e) { err = e; }
            assert.ok(err);
            assert.match(err.message, /waitForIndexer/);
            assert.strictEqual(err.partial.deploy.txid, 'deploy');
        });

        it('passes contractActionIndex to each deposit call', async function () {
            const depositCalls = [];
            const sdk = makeSdk({
                deposit: async (p) => { depositCalls.push(p); return { txid: 'dep' }; }
            });
            const wf = new Workflows(sdk);
            await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [
                { tick: 'TOK', quantity: '50' }
            ]);
            assert.strictEqual(depositCalls[0].contractActionIndex, 99);
            assert.strictEqual(depositCalls[0].tick, 'TOK');
            assert.strictEqual(depositCalls[0].quantity, '50');
        });
    });
});
