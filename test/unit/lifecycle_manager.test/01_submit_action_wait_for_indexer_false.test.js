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
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const {
    FAKE_WIF,
    buildChangeChain,
    buildSignedTx,
    makeSdk,
} = require('./helpers/lifecycle_manager.js');

// submitAction(): happy path, waitForIndexer=false

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=false", function () {
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=false", function () {
        it('carries a >2^53 change value as an exact decimal string, not a BigInt', function () {
            // applyBufferutilsPatch reads a large DOGE output value as a BigInt,
            // and JSON.stringify throws on one: the entry would kill the very
            // createTx call it exists to fund. The encoder's parseSatoshiAmount
            // takes the decimal-string form (allowBig), which is also what the
            // utxo-tracker emits for the same value.
            require('../../../src/utils/apply_bufferutils_patch.js');
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=false", function () {
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=false", function () {
        // "All" above meant all the fields this hand-written list happened to name,
        // and the list had fallen behind createTx: attachPrevTx, feeQuote, compress,
        // options and sourceAddress were dropped on the floor, so a submitAction
        // caller lost its protocol-fee output, its FILE compression policy, its
        // Taproot signer capability and its source-address UTXO selection in
        // silence. This one is driven off the shared list, so it cannot go stale.
        it('forwards EVERY field of the shared createTx option list', async function () {
            const EncoderClient = require('../../../src/clients/encoder.js');
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=false", function () {
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
});
