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
const Workflows = require('../../src/workflows.js');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

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
    };
}

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';
const FAKE_TICK = 'TOKEN';

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------
    describe('constructor', function () {
        it('stores the sdk reference', function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            assert.strictEqual(wf.sdk, sdk);
        });
    });

    // -----------------------------------------------------------------------
    //  issueAndDistribute()
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  issueAndMint()
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  createDispenser()
    // -----------------------------------------------------------------------
    describe('createDispenser()', function () {
        it('calls session.dispenser and returns result', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.createDispenser(FAKE_WIF, { giveTick: FAKE_TICK, giveAmount: '10' });
            assert.strictEqual(result.txid, 'dispenser_tx');
        });
    });

    // -----------------------------------------------------------------------
    //  createOrder()
    // -----------------------------------------------------------------------
    describe('createOrder()', function () {
        it('calls session.order and returns result', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.createOrder(FAKE_WIF, { giveTick: 'A', getTick: 'B' });
            assert.strictEqual(result.txid, 'order_tx');
        });
    });

    // -----------------------------------------------------------------------
    //  cancelOrder()
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  stakeAndDelegate()
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  stakeToContractAndDelegate()
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    //  deployAndFund()
    // -----------------------------------------------------------------------
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

        it('skips deposits when deploy indexed has no action_index (null)', async function () {
            const sdk = makeSdk({
                deploy: async () => ({ txid: 'deploy', indexed: null })
            });
            const wf = new Workflows(sdk);
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [
                { tick: 'A', quantity: '10' }
            ]);
            // indexed is null → contractActionIndex is null → deposits skipped
            assert.deepStrictEqual(result.deposits, []);
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

        it('skips deposits when deploy result has no indexed field', async function () {
            const sdk = makeSdk({
                deploy: async () => ({ txid: 'deploy' })
            });
            const wf = new Workflows(sdk);
            const result = await wf.deployAndFund(FAKE_WIF, { code: 'x' }, [
                { tick: 'A', quantity: '10' }
            ]);
            assert.deepStrictEqual(result.deposits, []);
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

    // -----------------------------------------------------------------------
    //  deployStakeableContract()
    // -----------------------------------------------------------------------
    describe('deployStakeableContract()', function () {
        it('delegates to deployAndFund with VERSION forced to "1"', async function () {
            const deployAndFundCalls = [];
            // Spy on deployAndFund
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const origDeployAndFund = wf.deployAndFund.bind(wf);
            wf.deployAndFund = async (wif, params, deposits, opts) => {
                deployAndFundCalls.push({ wif, params, deposits, opts });
                return origDeployAndFund(wif, params, deposits, opts);
            };

            const result = await wf.deployStakeableContract(
                FAKE_WIF,
                { code: 'contract', COOLDOWN_BLOCKS: 100, SLASH_DESTINATION: 'BURN' },
                [{ tick: 'A', quantity: '10' }]
            );
            assert.strictEqual(deployAndFundCalls[0].params.VERSION, '1');
            assert.strictEqual(deployAndFundCalls[0].params.COOLDOWN_BLOCKS, 100);
            assert.strictEqual(deployAndFundCalls[0].params.SLASH_DESTINATION, 'BURN');
        });

        it('throws when COOLDOWN_BLOCKS is missing', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });

        it('throws when COOLDOWN_BLOCKS is null', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: null, SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });

        it('throws when COOLDOWN_BLOCKS is empty string', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: '', SLASH_DESTINATION: 'BURN' }, []),
                /COOLDOWN_BLOCKS is required/
            );
        });

        it('throws when SLASH_DESTINATION is missing', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, { COOLDOWN_BLOCKS: 100 }, []),
                /SLASH_DESTINATION is required/
            );
        });

        it('throws when deployParams is null', async function () {
            const wf = new Workflows(makeSdk());
            await assert.rejects(
                () => wf.deployStakeableContract(FAKE_WIF, null, []),
                /COOLDOWN_BLOCKS is required/
            );
        });
    });

    // -----------------------------------------------------------------------
    //  distributeDividend()
    // -----------------------------------------------------------------------
    describe('distributeDividend()', function () {
        it('calls session.dividend and returns result', async function () {
            const sdk = makeSdk();
            const wf = new Workflows(sdk);
            const result = await wf.distributeDividend(
                FAKE_WIF,
                { tick: FAKE_TICK, dividendTick: 'DIV', amount: '1000' }
            );
            assert.strictEqual(result.txid, 'dividend_tx');
        });
    });

    // -----------------------------------------------------------------------
    //  attachContent() (optional on-chain TIS authoring legs)
    // -----------------------------------------------------------------------
    describe('attachContent()', function () {
        const NftHelpers = require('../../src/nft.js');

        function makeAttachSdk(calls) {
            let fileCount = 0;
            const session = {
                file: async (params, enc) => {
                    fileCount += 1;
                    calls.files.push({ params, enc });
                    return { txid: 'file_tx' + fileCount, indexed: { action_index: 100 + fileCount } };
                },
                link: async (params) => {
                    calls.links.push(params);
                    return { txid: 'link_tx', indexed: { action_index: 200 } };
                },
                issue: async (params) => {
                    calls.issues.push(params);
                    return { txid: 'describe_tx', indexed: { action_index: 300 } };
                },
            };
            const sdk = { session: () => session };
            sdk.nft = new NftHelpers(sdk);
            return sdk;
        }

        it('without tis: uploads + links only', async function () {
            const calls = { files: [], links: [], issues: [] };
            const wf = new Workflows(makeAttachSdk(calls));
            const out = await wf.attachContent(FAKE_WIF, {
                coin: 'BTC', issueActionIndex: 7,
                file: { name: 'a.png', type: 'image/png', rawData: 'x' },
            });
            assert.strictEqual(calls.files.length, 1);
            assert.strictEqual(calls.links.length, 1);
            assert.strictEqual(calls.issues.length, 0);
            assert.strictEqual(out.tisFile, undefined);
            assert.strictEqual(out.describe, undefined);
        });

        it('with tis: authors the on-chain doc and points DESCRIPTION at it', async function () {
            const calls = { files: [], links: [], issues: [] };
            const wf = new Workflows(makeAttachSdk(calls));
            const out = await wf.attachContent(FAKE_WIF, {
                coin: 'BTC', issueActionIndex: 7,
                file: { name: 'a.png', type: 'image/png', rawData: 'x' },
                tis: { tick: 'art1', name: 'Art One' },
            });
            // Second FILE upload is the TIS JSON document...
            assert.strictEqual(calls.files.length, 2);
            const tisUpload = calls.files[1];
            assert.strictEqual(tisUpload.params.name, 'ART1.json');
            assert.strictEqual(tisUpload.params.type, 'application/json');
            const doc = JSON.parse(Buffer.from(tisUpload.enc.rawData, 'binary').toString('utf8'));
            // ...whose images[] data_ref points at the artwork upload (action 101)
            assert.strictEqual(doc.images[0].data_ref, 'action:101');
            assert.strictEqual(doc.tick, 'ART1');
            // ...and ISSUE v1 points the token's DESCRIPTION at the doc (action 102)
            assert.strictEqual(calls.issues.length, 1);
            assert.deepStrictEqual(calls.issues[0], {
                version: '1', tick: 'art1', description: 'action:102',
            });
            assert.strictEqual(out.tisFile.txid, 'file_tx2');
            assert.strictEqual(out.describe.txid, 'describe_tx');
        });
    });
});
