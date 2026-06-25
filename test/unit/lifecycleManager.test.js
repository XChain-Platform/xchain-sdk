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
const LifecycleManager = require('../../src/lifecycleManager.js');
const ActionWaiter = require('../../src/actionWaiter.js');

// ---------------------------------------------------------------------------
//  Helpers: minimal fake SDK and collaborators
// ---------------------------------------------------------------------------

// A valid signed P2WPKH tx hex that bitcoinjs-lib can parse (so
// _extractSpentInputs works without a real PSBT). We build it using
// bitcoinjs-lib itself so the bytes are structurally correct.
let _cachedPsbtHex = null;
function buildTestPsbtHex() {
    if (_cachedPsbtHex) return _cachedPsbtHex;
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);

    const net = bitcoin.networks.regtest;
    const kp = ECPair.makeRandom({ network: net });
    const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;

    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inputScript, 100_000);

    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({
        hash:        prevTx.getId(),
        index:       0,
        sequence:    0xfffffffd,
        witnessUtxo: { script: inputScript, value: 100_000 },
    });
    psbt.addOutput({ script: inputScript, value: 90_000 });
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    _cachedPsbtHex = psbt.toHex();
    return _cachedPsbtHex;
}

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

function buildSignedTx() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);
    const net = bitcoin.networks.regtest;
    const kp = ECPair.makeRandom({ network: net });
    const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inputScript, 100_000);
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 100_000 } });
    psbt.addOutput({ script: inputScript, value: 90_000 });
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { psbtHex: psbt.toHex(), txHex: tx.toHex(), txid: tx.getId() };
}

/**
 * Build a minimal fake SDK.
 *
 * @param {Object} [overrides]  – override specific sdk methods
 * @param {Object} [encoderOverrides] – override encoder methods
 */
function makeSdk(overrides = {}, encoderOverrides = {}) {
    const signed = buildSignedTx();

    const defaultEncoder = {
        createTx:    async () => ({ psbt: signed.psbtHex, encoding: 'OP_RETURN' }),
        broadcastTx: async () => ({ txid: signed.txid }),
        spendP2sh:   async () => ({ psbt: signed.psbtHex }),
    };
    const encoder = Object.assign({}, defaultEncoder, encoderOverrides);

    const defaultSdk = {
        _requireEncoder: () => encoder,
        actions: {
            createAction: () => ({
                actionString: 'XCHAIN|SEND|...',
                action:       'SEND',
                version:      1,
            }),
        },
        // Ticker + address compaction run before createAction; pass params through.
        tickResolver: {
            resolveActionParams: async (action, params) => params,
        },
        addressResolver: {
            resolveActionParams: async (action, params) => params,
        },
        wallet: {
            signPsbt:       () => ({ txHex: signed.txHex, txid: signed.txid, psbtHex: signed.psbtHex }),
            signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'phase2txid', psbtHex: signed.psbtHex }),
        },
    };

    return Object.assign({}, defaultSdk, overrides);
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------
    describe('constructor', function () {
        it('stores the sdk reference', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            assert.strictEqual(lm.sdk, sdk);
        });
    });

    // -----------------------------------------------------------------------
    //  submitAction(): missing WIF
    // -----------------------------------------------------------------------
    describe('submitAction(): missing WIF', function () {
        it('throws SDKConfigError MISSING_WIF when wif is absent', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {}, {});
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_WIF');
            }
        });

        it('throws MISSING_WIF when wif is null', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: null });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_WIF');
            }
        });
    });

    // -----------------------------------------------------------------------
    //  submitAction(): happy path, waitForIndexer=false
    // -----------------------------------------------------------------------
    describe('submitAction(): waitForIndexer=false', function () {
        it('returns result with txid, actionString, encoding without waiting', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: { tick: 'TOK' } },
                { pubkey: '03abc' },
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            assert.ok(result.txid);
            assert.strictEqual(result.actionString, 'XCHAIN|SEND|...');
            assert.strictEqual(result.encoding, 'OP_RETURN');
            assert.strictEqual(result.indexed, null);
        });

        it('includes spentInputs array in result', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            assert.ok(Array.isArray(result.spentInputs));
        });

        it('passes all optional encoderOpts fields to createTx', async function () {
            const captured = [];
            const signed = buildSignedTx();
            const sdk = makeSdk({}, {
                createTx: async (p) => { captured.push(p); return { psbt: signed.psbtHex, encoding: 'OP_RETURN' }; }
            });
            const lm = new LifecycleManager(sdk);
            await lm.submitAction(
                { action: 'SEND', params: {} },
                {
                    pubkey: '03pub', change: 'chaddr', utxos: [{ txid: 'u1', vout: 0 }],
                    rawData: 'raw', encoding: 'OP_RETURN', fee: 1000, feePerKb: 1,
                    rbf: true, dust: 546, unconfirmed: false, compressedPubKey: true,
                    customOutputs: []
                },
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            const p = captured[0];
            assert.strictEqual(p.change, 'chaddr');
            assert.strictEqual(p.fee, 1000);
            assert.strictEqual(p.rbf, true);
            assert.deepStrictEqual(p.customOutputs, []);
        });

        it('fires onProgress callbacks for each step', async function () {
            const steps = [];
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: false, onProgress: (step) => steps.push(step) }
            );
            assert.ok(steps.includes('creating'));
            assert.ok(steps.includes('encoding'));
            assert.ok(steps.includes('signing'));
            assert.ok(steps.includes('broadcasting'));
        });
    });

    // -----------------------------------------------------------------------
    //  submitAction(): P2SH two-phase path
    // -----------------------------------------------------------------------
    describe('submitAction(): P2SH two-phase encoding', function () {
        it('runs phase-2 when encoding is P2SH, broadcasts twice, returns phase-2 txid', async function () {
            const steps = [];
            const signed = buildSignedTx();
            // Override encoder to return P2SH encoding on createTx
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: signed.txHex, txid: 'phase1txid', psbtHex: signed.psbtHex }),
                    signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'phase2txid', psbtHex: signed.psbtHex }),
                }
            }, {
                createTx: async () => ({ psbt: signed.psbtHex, encoding: 'P2SH' }),
                spendP2sh: async () => ({ psbt: signed.psbtHex }),
                broadcastTx: async () => ({ txid: 'broadcast_ok' }),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                { pubkey: '03pub', change: 'addr', fee: 1000 },
                { wif: FAKE_WIF, waitForIndexer: false, onProgress: (s) => steps.push(s) }
            );
            assert.strictEqual(result.txid, 'phase2txid');
            assert.ok(steps.includes('p2sh_spending'));
        });

        it('runs phase-2 when encoding is P2WSH', async function () {
            const signed = buildSignedTx();
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: signed.txHex, txid: 'phase1', psbtHex: signed.psbtHex }),
                    signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'phase2', psbtHex: signed.psbtHex }),
                }
            }, {
                createTx: async () => ({ psbt: signed.psbtHex, encoding: 'P2WSH' }),
                spendP2sh: async () => ({ psbt: signed.psbtHex }),
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            assert.strictEqual(result.txid, 'phase2');
        });

        // Regression for #5352: on native-fee chains the protocol-fee output
        // rides customOutputs. For the two-phase P2SH/P2WSH flow the indexer
        // treats the reveal (phase 2) as the action and reads the fee output from
        // it, so customOutputs MUST reach phase-2 spendP2sh. The encoder fences
        // double-pay (funds-but-does-not-emit on the funding tx), so phase-1
        // createTx legitimately also carries customOutputs; what matters is that
        // phase 2 carries it and the fee value reaches the reveal.
        it('forwards customOutputs to phase-2 spendP2sh (#5352 native-fee fix)', async function () {
            const signed = buildSignedTx();
            const feeOutputs = [{ address: 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4', value: 10678 }];
            let createTxParams = null;
            let spendP2shParams = null;
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: signed.txHex, txid: 'p1txid', psbtHex: signed.psbtHex }),
                    signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'p2txid', psbtHex: signed.psbtHex }),
                }
            }, {
                createTx:    async (p) => { createTxParams = p; return { psbt: signed.psbtHex, encoding: 'P2SH' }; },
                spendP2sh:   async (p) => { spendP2shParams = p; return { psbt: signed.psbtHex }; },
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            await lm.submitAction(
                { action: 'DEPLOY', params: {} },
                { pubkey: '03pub', change: 'addr', customOutputs: feeOutputs },
                { wif: FAKE_WIF, waitForIndexer: false }
            );

            // Phase 2 (the reveal, indexed as the action) must carry the fee output.
            assert.ok(spendP2shParams, 'spendP2sh should have been called');
            assert.deepStrictEqual(spendP2shParams.customOutputs, feeOutputs,
                'phase-2 reveal must carry the native-fee customOutputs');
            // Phase 1 also receives it; the encoder funds-but-does-not-emit there,
            // so this is not a double-pay (see XChainEncoder #5352 funding logic).
            assert.deepStrictEqual(createTxParams.customOutputs, feeOutputs);
        });

        it('concatenates phase-1 and phase-2 spentInputs', async function () {
            const signed = buildSignedTx();
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: signed.txHex, txid: 'p1txid', psbtHex: signed.psbtHex }),
                    signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'p2txid', psbtHex: signed.psbtHex }),
                }
            }, {
                createTx: async () => ({ psbt: signed.psbtHex, encoding: 'P2SH' }),
                spendP2sh: async () => ({ psbt: signed.psbtHex }),
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            // Both phase-1 and phase-2 should contribute spentInputs
            assert.ok(Array.isArray(result.spentInputs));
            // The psbt has 1 input, so spentInputs from both phases = 2
            assert.strictEqual(result.spentInputs.length, 2);
        });
    });

    // -----------------------------------------------------------------------
    //  submitAction(): waitForIndexer=true
    // -----------------------------------------------------------------------
    describe('submitAction(): waitForIndexer=true', function () {
        it('waits for indexer and populates result.indexed', async function () {
            const indexedAction = { action: 'SEND', status: 'valid', tx_hash: 'fakeid' };
            // Stub ActionWaiter.prototype.waitForTxid to resolve immediately
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves(indexedAction);

            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: true, timeout: 5000, pollInterval: 100 }
            );
            assert.deepStrictEqual(result.indexed, indexedAction);
        });

        it('defaults waitForIndexer to true and calls ActionWaiter', async function () {
            const waiterStub = sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            // Not specifying waitForIndexer → defaults to true
            await lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: FAKE_WIF });
            assert.ok(waiterStub.calledOnce);
        });

        it('fires confirmed progress step after indexer confirms', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const steps = [];
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: true, onProgress: (s) => steps.push(s) }
            );
            assert.ok(steps.includes('waiting'));
            assert.ok(steps.includes('confirmed'));
        });
    });

    // -----------------------------------------------------------------------
    //  _extractSpentInputs()
    // -----------------------------------------------------------------------
    describe('_extractSpentInputs()', function () {
        it('returns array of {txid, vout} objects from a valid PSBT hex', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const psbtHex = buildTestPsbtHex();
            const inputs = lm._extractSpentInputs(psbtHex);
            assert.ok(Array.isArray(inputs));
            assert.ok(inputs.length >= 1);
            assert.ok(typeof inputs[0].txid === 'string' && inputs[0].txid.length === 64);
            assert.ok(typeof inputs[0].vout === 'number');
        });

        it('returns empty array for invalid PSBT hex (does not throw)', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = lm._extractSpentInputs('not-valid-psbt-hex');
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for empty string', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            assert.deepStrictEqual(lm._extractSpentInputs(''), []);
        });
    });
});
