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

// submitAction(): P2SH two-phase path

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): P2SH two-phase encoding", function () {
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): P2SH two-phase encoding", function () {
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
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): P2SH two-phase encoding", function () {
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
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): P2SH two-phase encoding", function () {
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
});
