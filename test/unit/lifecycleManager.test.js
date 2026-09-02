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

// Helpers: minimal fake SDK and collaborators

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
    // The encoder answers UNSIGNED, and reconcileEncoded no longer reads a PRE-SIGNED
    // input's script as a signer-owned change destination, so the mock has
    // to hand back the pre-signature hex. The signing below exists only to produce a
    // broadcastable txHex/txid for the broadcast mock.
    const unsignedHex = psbt.toHex();
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { psbtHex: unsignedHex, txHex: tx.toHex(), txid: tx.getId() };
}

/**
 * A two-transaction chain built with real keys, for the change-tracking tests.
 *
 * tx1 carries an OP_RETURN data output plus change back to `changeAddress` at
 * vout 1; tx2 SPENDS that change output and pays its own change back. This is
 * the shape the P2SH two-phase flow produces, where the reveal consumes what
 * the funding transaction paid the caller.
 *
 * Everything is on the bitcoinjs DEFAULT network, because the fake SDK has no
 * wallet.getBitcoinNetwork and _reconcileNetwork therefore falls back to it.
 */
function buildChangeChain() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);

    const kp        = ECPair.makeRandom();
    const inScript  = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).output;
    const change    = bitcoin.payments.p2pkh({ pubkey: kp.publicKey });
    const opReturn  = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]);

    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inScript, 100_000);

    const psbt1 = new bitcoin.Psbt();
    psbt1.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd,
                     witnessUtxo: { script: inScript, value: 100_000 } });
    psbt1.addOutput({ script: opReturn, value: 0 });
    psbt1.addOutput({ address: change.address, value: 90_000 });
    const psbt1Hex = psbt1.toHex();          // the encoder answers UNSIGNED
    psbt1.signAllInputs(kp);
    psbt1.finalizeAllInputs();
    const tx1 = psbt1.extractTransaction();

    const psbt2 = new bitcoin.Psbt();
    psbt2.addInput({ hash: tx1.getId(), index: 1, sequence: 0xfffffffd, nonWitnessUtxo: tx1.toBuffer() });
    psbt2.addOutput({ address: change.address, value: 80_000 });
    const psbt2Hex = psbt2.toHex();
    psbt2.signAllInputs(kp);
    psbt2.finalizeAllInputs();
    const tx2 = psbt2.extractTransaction();

    return {
        changeAddress: change.address,
        changeScript:  change.output.toString('hex'),
        // The same key as a raw hex pubkey. The reconcile gate derives the
        // caller's default-type scripts from it, so a change output still
        // reconciles; _extractChangeOutputs cannot parse it as an address.
        pubkeyHex:     Buffer.from(kp.publicKey).toString('hex'),
        phase1: { psbtHex: psbt1Hex, txHex: tx1.toHex(), txid: tx1.getId() },
        phase2: { psbtHex: psbt2Hex, txHex: tx2.toHex(), txid: tx2.getId() },
    };
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

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    // Constructor
    describe('constructor', function () {
        it('stores the sdk reference', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            assert.strictEqual(lm.sdk, sdk);
        });
    });

    // submitAction(): missing WIF
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

    // submitAction(): happy path, waitForIndexer=false
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

        // Without these, the change a submit pays back to the caller is
        // never handed to the UTXO cache, so the caller's NEXT action picks
        // independent confirmed inputs and lands as a SIBLING of this one
        // instead of its child.
        it('returns the change output paid back to the caller, shaped for createTx', async function () {
            const chain = buildChangeChain();
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: chain.phase1.txHex, txid: chain.phase1.txid, psbtHex: chain.phase1.psbtHex }),
                    signRevealPsbt: () => ({ txHex: chain.phase2.txHex, txid: chain.phase2.txid, psbtHex: chain.phase2.psbtHex }),
                }
            }, {
                createTx:    async () => ({ psbt: chain.phase1.psbtHex, encoding: 'OP_RETURN' }),
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                { pubkey: chain.changeAddress, change: chain.changeAddress },
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            // The OP_RETURN carrier at vout 0 is not the caller's coin; only the
            // change at vout 1 comes back, with every field the encoder's
            // validateUtxoEntry demands of a caller-supplied utxos entry.
            assert.deepStrictEqual(result.changeOutputs, [{
                txid:          chain.phase1.txid,
                vout:          1,
                value:         90_000,
                scriptPubKey:  chain.changeScript,
                confirmations: 0
            }]);
        });

        it('carries a >2^53 change value as an exact decimal string, not a BigInt', function () {
            // applyBufferutilsPatch reads a large DOGE output value as a BigInt,
            // and JSON.stringify throws on one: the entry would kill the very
            // createTx call it exists to fund. The encoder's parseSatoshiAmount
            // takes the decimal-string form (allowBig), which is also what the
            // utxo-tracker emits for the same value.
            require('../../src/applyBufferutilsPatch.js');
            const bitcoin = require('bitcoinjs-lib');
            const chain = buildChangeChain();
            const big   = 9007199254740993n;      // 2^53 + 1

            const tx = new bitcoin.Transaction();
            tx.addInput(Buffer.alloc(32), 0);
            tx.addOutput(bitcoin.address.toOutputScript(chain.changeAddress), big);

            const lm  = new LifecycleManager(makeSdk());
            const out = lm._extractChangeOutputs(tx.toHex(), chain.changeAddress);
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].value, '9007199254740993');
            assert.doesNotThrow(() => JSON.stringify(out));
        });

        it('tracks no change when the change destination is not a parseable address', async function () {
            const chain = buildChangeChain();
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: chain.phase1.txHex, txid: chain.phase1.txid, psbtHex: chain.phase1.psbtHex }),
                    signRevealPsbt: () => ({ txHex: chain.phase2.txHex, txid: chain.phase2.txid, psbtHex: chain.phase2.psbtHex }),
                }
            }, {
                createTx:    async () => ({ psbt: chain.phase1.psbtHex, encoding: 'OP_RETURN' }),
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            // A raw hex pubkey is not an address; nothing can be matched, and the
            // fail-closed answer is an empty list rather than a guessed script.
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                { pubkey: chain.pubkeyHex },
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            assert.deepStrictEqual(result.changeOutputs, []);
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

        // "All" above meant all the fields this hand-written list happened to name,
        // and the list had fallen behind createTx: attachPrevTx, feeQuote, compress,
        // options and sourceAddress were dropped on the floor, so a submitAction
        // caller lost its protocol-fee output, its FILE compression policy, its
        // Taproot signer capability and its source-address UTXO selection in
        // silence. This one is driven off the shared list, so it cannot go stale.
        it('forwards EVERY field of the shared createTx option list', async function () {
            const EncoderClient = require('../../src/encoder.js');
            const captured = [];
            const signed = buildSignedTx();
            const sdk = makeSdk({}, {
                createTx: async (p) => { captured.push(p); return { psbt: signed.psbtHex, encoding: 'OP_RETURN' }; }
            });
            const encoderOpts = { pubkey: '03pub' };
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) encoderOpts[key] = 'set:' + key;
            encoderOpts.encoding      = 'OP_RETURN';   // steers the two-phase branch
            encoderOpts.customOutputs = [];            // read by the reconcile intent
            const lm = new LifecycleManager(sdk);
            await lm.submitAction({ action: 'SEND', params: {} }, encoderOpts,
                { wif: FAKE_WIF, waitForIndexer: false });
            const p = captured[0];
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS)
                assert.deepStrictEqual(p[key], encoderOpts[key], key + ' must reach createTx');
        });

        it('omits optional encoderOpts fields the caller did not set', async function () {
            const captured = [];
            const signed = buildSignedTx();
            const sdk = makeSdk({}, {
                createTx: async (p) => { captured.push(p); return { psbt: signed.psbtHex, encoding: 'OP_RETURN' }; }
            });
            const lm = new LifecycleManager(sdk);
            await lm.submitAction({ action: 'SEND', params: {} }, { pubkey: '03pub' },
                { wif: FAKE_WIF, waitForIndexer: false });
            // Absent and explicit-false are different wire meanings to createTx
            // (compress is tri-state), so an unset field must not appear at all.
            assert.strictEqual(Object.prototype.hasOwnProperty.call(captured[0], 'compress'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(captured[0], 'feeQuote'), false);
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

    // submitAction(): P2SH two-phase path
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

        it('drops a phase-1 change output that phase 2 spends back', async function () {
            const chain = buildChangeChain();
            const sdk = makeSdk({
                wallet: {
                    signPsbt:       () => ({ txHex: chain.phase1.txHex, txid: chain.phase1.txid, psbtHex: chain.phase1.psbtHex }),
                    signRevealPsbt: () => ({ txHex: chain.phase2.txHex, txid: chain.phase2.txid, psbtHex: chain.phase2.psbtHex }),
                }
            }, {
                createTx:    async () => ({ psbt: chain.phase1.psbtHex, encoding: 'P2SH' }),
                spendP2sh:   async () => ({ psbt: chain.phase2.psbtHex }),
                broadcastTx: async () => ({}),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'DEPLOY', params: {} },
                { pubkey: chain.changeAddress, change: chain.changeAddress },
                { wif: FAKE_WIF, waitForIndexer: false }
            );
            // Phase 2 consumes phase 1's change, so handing it back as spendable
            // would put a provably-spent outpoint into the caller's UTXO set and
            // the encoder would build a double-spend from it. Only the reveal's
            // own change survives.
            assert.deepStrictEqual(result.changeOutputs, [{
                txid:          chain.phase2.txid,
                vout:          0,
                value:         80_000,
                scriptPubKey:  chain.changeScript,
                confirmations: 0
            }]);
        });
    });

    // submitAction(): waitForIndexer=true
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

    // submitAction(): a chain-REJECTED action must not look like a success.
    // These run the REAL ActionWaiter against a fake explorer, so they pin the
    // caller-visible contract end to end rather than a stub.
    describe('submitAction(): rejected actions', function () {

        // Fake explorer returning one canned transaction for every poll.
        function explorerReturning(txResult) {
            return { getTransaction: async () => txResult };
        }

        it('rejects with the indexer-recorded reason when the action is invalid', async function () {
            const sdk = makeSdk({
                ws: null,
                _requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    actions: [{ action: 'BET', action_index: 7, status: 'invalid: OUTCOME (range)' }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            await assert.rejects(
                () => lm.submitAction({ action: 'BET', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true, timeout: 3000, pollInterval: 50 }),
                (err) => {
                    assert.strictEqual(err.code, 'ACTION_REJECTED');
                    assert.strictEqual(err.details.reason, 'invalid: OUTCOME (range)');
                    return true;
                });
        });

        it('reports whether the resolved status was read from the indexer or assumed', async function () {
            const sdk = makeSdk({
                ws: null,
                _requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    actions: [{ action: 'SEND', action_index: 7, status: 'valid' }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction({ action: 'SEND', params: {} }, {},
                { wif: FAKE_WIF, waitForIndexer: true, timeout: 3000, pollInterval: 50 });
            assert.strictEqual(result.indexed.status, 'valid');
            assert.strictEqual(result.indexed.statusKnown, true);
            assert.strictEqual(result.indexed.statusSource, 'indexer');
        });

        it('forwards strictStatus so a caller can fail closed on an unreadable status', async function () {
            const sdk = makeSdk({
                ws: null,
                _requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    // Status-less action row: the indexer wrote no typed row for this leg.
                    actions: [{ action: 'BET', action_index: 7, status: null }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            await assert.rejects(
                () => lm.submitAction({ action: 'BET', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true, timeout: 1200, pollInterval: 50, strictStatus: true }),
                (err) => {
                    assert.strictEqual(err.code, 'ACTION_STATUS_UNKNOWN');
                    return true;
                });
        });
    });

    // _extractSpentInputs()
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
    // submitAction(): a wait that expires after a SUCCESSFUL broadcast
    describe('submitAction(): indexing wait expires', function () {
        // The broadcast happens before the wait, so an expired wait is not a
        // failed action: the transaction is on the network needing a block, which
        // chains with long or irregular block times hit routinely. Marking it is
        // what lets a caller say "accepted, awaiting confirmation" instead of
        // reporting a failure, and what stops a retry from rebuilding and
        // re-spending the same inputs.
        it('marks the timeout as broadcast so it is not read as a failed action', async function () {
            const { SDKActionError } = require('../../src/errors.js');
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(
                new SDKActionError('CONFIRMATION_TIMEOUT', 'not indexed', { txid: 'abc', timeout: 1 }));
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true });
                assert.fail('expected the wait to reject');
            } catch (err) {
                assert.strictEqual(err.code, 'CONFIRMATION_TIMEOUT');
                assert.strictEqual(err.broadcast, true, 'the broadcast succeeded before the wait began');
                assert.ok(err.txid, 'the caller needs the txid to check the mempool');
                assert.strictEqual(err.details.broadcast, true);
            } finally {
                ActionWaiter.prototype.waitForTxid.restore();
            }
        });

        it('leaves other wait failures unmarked', async function () {
            const { SDKActionError } = require('../../src/errors.js');
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(
                new SDKActionError('ACTION_INVALID', 'rejected by the indexer', {}));
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true });
                assert.fail('expected the wait to reject');
            } catch (err) {
                assert.strictEqual(err.code, 'ACTION_INVALID');
                assert.strictEqual(err.broadcast, undefined, 'only a timeout means "sent but unconfirmed"');
            } finally {
                ActionWaiter.prototype.waitForTxid.restore();
            }
        });
    });
});
