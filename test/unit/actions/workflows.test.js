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
const Workflows = require('../../../src/actions/workflows.js');

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

    // Constructor
    describe('constructor', function () {
        it('stores the sdk reference', function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            assert.strictEqual(wf.sdk, sdk);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // issueAndDistribute()
    describe('issueAndDistribute()', function () {
        it('issues then sends to each recipient', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const issueParams = { tick: FAKE_TICK, maxSupply: '1000', decimals: 0 };
            const distributions = [
                { destination: 'addr1', amount: '100' },
                { destination: 'addr2', amount: '200', memo: 'hello' },
            ];
            const result = await wf.issueAndDistribute(FAKE_WIF, issueParams, distributions);
            assert.ok(result.issue, 'should have issue result');
            assert.strictEqual(result.issue.txid, 'issue_tx');
            assert.strictEqual(result.sends.length, 2);
            assert.strictEqual(result.sends[0].txid, 'send_tx');
            assert.strictEqual(result.sends[1].txid, 'send_tx');
        });

        it('returns empty sends array when distributions is empty', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.issueAndDistribute(FAKE_WIF, { tick: FAKE_TICK }, []);
            assert.strictEqual(result.sends.length, 0);
        });

        it('on a later-step failure, attaches partial results (prior txids) to the error', async function () {
            let calls = 0;
            const sdk = makeSdk({
                send: async () => { calls++; if (calls === 2) throw new Error('node down'); return { txid: 'send_tx_' + calls }; }
            });
            const wf = new Workflows(sdk);
            const distributions = [{ destination: 'a', amount: '1' }, { destination: 'b', amount: '2' }, { destination: 'c', amount: '3' }];
            let err;
            try { await wf.issueAndDistribute(FAKE_WIF, { tick: FAKE_TICK }, distributions); }
            catch (e) { err = e; }
            assert.ok(err, 'should throw');
            assert.ok(err.partial, 'error must carry partial results');
            assert.strictEqual(err.partial.issue.txid, 'issue_tx');    // ISSUE succeeded, not lost
            assert.strictEqual(err.partial.sends.length, 1);           // first SEND succeeded, not lost
            assert.strictEqual(err.partial.sends[0].txid, 'send_tx_1');
        });

        it('passes tick from issueParams to each send', async function () {
            const captured = [];
            const sdk = makeSdk({
                send: async (p) => { captured.push(p.tick); return { txid: 'tx' }; }
            });
            const wf = new Workflows(sdk);
            await wf.issueAndDistribute(FAKE_WIF, { tick: 'CUSTOM' }, [
                { destination: 'addr1', amount: '10' }
            ]);
            assert.deepStrictEqual(captured, ['CUSTOM']);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // issueAndMint()
    describe('issueAndMint()', function () {
        it('calls issue then mint, merging tick', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.issueAndMint(
                FAKE_WIF,
                { tick: FAKE_TICK, maxSupply: '1000' },
                { amount: '500', destination: 'addr1' }
            );
            assert.strictEqual(result.issue.txid, 'issue_tx');
            assert.strictEqual(result.mint.txid, 'mint_tx');
        });

        it('passes tick from issueParams into mintParams', async function () {
            const mintCalls = [];
            const sdk = makeSdk({
                mint: async (p) => { mintCalls.push(p); return { txid: 'mint' }; }
            });
            const wf = new Workflows(sdk);
            await wf.issueAndMint(FAKE_WIF, { tick: 'TKN' }, { amount: '100' });
            assert.strictEqual(mintCalls[0].tick, 'TKN');
            assert.strictEqual(mintCalls[0].amount, '100');
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // createDispenser()
    describe('createDispenser()', function () {
        it('calls session.dispenser and returns result', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.createDispenser(FAKE_WIF, { giveTick: FAKE_TICK, giveAmount: '10' });
            assert.strictEqual(result.txid, 'dispenser_tx');
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // createOrder()
    describe('createOrder()', function () {
        it('calls session.order and returns result', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.createOrder(FAKE_WIF, { giveTick: 'A', getTick: 'B' });
            assert.strictEqual(result.txid, 'order_tx');
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // cancelOrder()
    describe('cancelOrder()', function () {
        it('calls session.order with orderActionIndex', async function () {
            const orderCalls = [];
            const sdk = makeSdk({
                order: async (p) => { orderCalls.push(p); return { txid: 'cancel_tx' }; }
            });
            const wf = new Workflows(sdk);
            const result = await wf.cancelOrder(FAKE_WIF, 777);
            assert.strictEqual(result.txid, 'cancel_tx');
            assert.strictEqual(orderCalls[0].orderActionIndex, 777);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // stakeAndDelegate()
    describe('stakeAndDelegate()', function () {
        it('stakes then delegates when delegateParams is provided', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.stakeAndDelegate(
                FAKE_WIF,
                { version: 1, amount: '100', signingPubkey: '03abc' },
                { newSigningPubkey: '03def' }
            );
            assert.strictEqual(result.stake.txid, 'stake_tx');
            assert.strictEqual(result.delegate.txid, 'delegate_tx');
        });

        it('returns delegate:null when delegateParams is omitted', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.stakeAndDelegate(FAKE_WIF, { version: 1, amount: '50' });
            assert.strictEqual(result.stake.txid, 'stake_tx');
            assert.strictEqual(result.delegate, null);
        });

        it('returns delegate:null when delegateParams is null', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.stakeAndDelegate(FAKE_WIF, { version: 1 }, null);
            assert.strictEqual(result.delegate, null);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // stakeToContractAndDelegate()
    describe('stakeToContractAndDelegate()', function () {
        it('stakes to contract and delegates when delegateParams provided', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.stakeToContractAndDelegate(
                FAKE_WIF,
                { AMOUNT: '100', SIGNING_PUBKEY: '03aa', TARGET_CONTRACT_INDEX: 5, TICK: 'T' },
                { SIGNING_PUBKEY: '03bb', TARGET_CONTRACT_INDEX: 5, TICK: 'T' }
            );
            assert.strictEqual(result.stake.txid, 'stake_contract_tx');
            assert.strictEqual(result.delegate.txid, 'delegate_contract_tx');
        });

        it('returns delegate:null when delegateParams is null', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.stakeToContractAndDelegate(
                FAKE_WIF,
                { AMOUNT: '100', SIGNING_PUBKEY: '03aa', TARGET_CONTRACT_INDEX: 5, TICK: 'T' },
                null
            );
            assert.strictEqual(result.delegate, null);
        });
    });
});
