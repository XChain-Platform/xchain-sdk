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
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const { FAKE_WIF, buildSignedTx, makeSdk } = require('./helpers/lifecycle_manager.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin; // the fake SDK reconciles on the bitcoinjs default network

// An unsigned PSBT that pays `quoteValue` to a hub fee address besides its change.
function buildQuotePsbt(quoteValue) {
    const kp = ECPair.makeRandom({ network: NET });
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: NET }).output;
    const feeKp = ECPair.makeRandom({ network: NET });
    const feeAddress = bitcoin.payments.p2wpkh({ pubkey: feeKp.publicKey, network: NET }).address;
    const prev = new bitcoin.Transaction();
    prev.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prev.addOutput(script, 100_000);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prev.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script, value: 100_000 } });
    psbt.addOutput({ script, value: 80_000 });
    psbt.addOutput({ address: feeAddress, value: quoteValue });
    return { psbtHex: psbt.toHex(), feeAddress };
}

function run(encoding, built, feeQuote) {
    const signed = buildSignedTx();
    const sdk = makeSdk({
        wallet: {
            signPsbt:       () => ({ txHex: signed.txHex, txid: 'p1', psbtHex: signed.psbtHex }),
            signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'p2', psbtHex: signed.psbtHex }),
        }
    }, {
        createTx:    async () => ({ psbt: built.psbtHex, encoding }),
        spendP2sh:   async () => ({ psbt: signed.psbtHex }),
        broadcastTx: async () => ({}),
    });
    return new LifecycleManager(sdk).submitAction(
        { action: 'SEND', params: {} },
        { pubkey: '03pub', change: 'addr', feeQuote },
        { wif: FAKE_WIF, waitForIndexer: false }
    );
}

describe('LifecycleManager', function () {
    afterEach(() => sinon.restore());

    describe('submitAction(): feeQuote authorized output', function () {
        it('accepts the hub fee output the caller quoted', async function () {
            const built = buildQuotePsbt(10_000);
            const result = await run(undefined, built, { address: built.feeAddress, amount: 10_000 });
            assert.ok(result.txid);
        });

        it('rejects the same output without a quote', async function () {
            const built = buildQuotePsbt(10_000);
            await assert.rejects(run(undefined, built, undefined), /UNRECONCILED_OUTPUT|reconcil/i);
        });

        it('caps the output at the quoted amount', async function () {
            const built = buildQuotePsbt(10_000);
            await assert.rejects(run(undefined, built, { address: built.feeAddress, amount: 5_000 }),
                /UNRECONCILED_OUTPUT|reconcil/i);
        });

        it('does not authorize the quote output on the P2SH funding phase', async function () {
            const built = buildQuotePsbt(10_000);
            await assert.rejects(run('P2SH', built, { address: built.feeAddress, amount: 10_000 }),
                /UNRECONCILED_OUTPUT|reconcil/i);
        });
    });
});

// A chunked submit: phase 1 funds with change only, and the reveal pays the hub fee output.
function runChunked(encoding, revealQuoteValue, feeQuote) {
    const signed = buildSignedTx();
    const funding = buildQuotePsbt(0);
    const reveal = buildQuotePsbt(revealQuoteValue);
    const fundingOnly = bitcoin.Psbt.fromHex(funding.psbtHex, { network: NET });
    const stripped = new bitcoin.Psbt({ network: NET });
    stripped.addInput(Object.assign({ hash: fundingOnly.txInputs[0].hash, index: 0 }, fundingOnly.data.inputs[0]));
    stripped.addOutput({ script: fundingOnly.txOutputs[0].script, value: 80_000 });
    const spendCalls = [];
    const sdk = makeSdk({
        wallet: {
            signPsbt:       () => ({ txHex: signed.txHex, txid: 'p1', psbtHex: signed.psbtHex }),
            signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'p2', psbtHex: signed.psbtHex }),
        }
    }, {
        createTx:    async () => ({ psbt: stripped.toHex(), encoding }),
        spendP2sh:   async (p) => { spendCalls.push(p); return { psbt: reveal.psbtHex }; },
        broadcastTx: async () => ({}),
    });
    const quote = feeQuote ? Object.assign({ address: reveal.feeAddress }, feeQuote) : undefined;
    const done = new LifecycleManager(sdk).submitAction(
        { action: 'SEND', params: {} },
        { pubkey: '03pub', change: 'addr', feeQuote: quote },
        { wif: FAKE_WIF, waitForIndexer: false }
    );
    return { done, spendCalls, quote };
}

async function chunkedError(encoding, revealQuoteValue, feeQuote) {
    try { await runChunked(encoding, revealQuoteValue, feeQuote).done; }
    catch (e) { return e; }
    return null;
}

describe('LifecycleManager', function () {
    afterEach(() => sinon.restore());

    describe('submitAction(): feeQuote on a chunked reveal', function () {
        for (const encoding of ['P2SH', 'P2WSH']) {
            it('forwards the quote to the ' + encoding + ' reveal and accepts its fee output', async function () {
                const run2 = runChunked(encoding, 10_000, { amount: 10_000 });
                const result = await run2.done;
                assert.strictEqual(result.txid, 'p2');
                assert.deepStrictEqual(run2.spendCalls[0].feeQuote, run2.quote);
            });
        }

        it('sends no feeQuote to the reveal when the caller quoted none', async function () {
            const run2 = runChunked('P2SH', 10_000, null);
            await run2.done.catch(() => null);
            assert.ok(!('feeQuote' in run2.spendCalls[0]));
        });

        it('refuses a reveal fee output the caller never quoted', async function () {
            const err = await chunkedError('P2SH', 10_000, null);
            assert.strictEqual(err && err.code, 'UNRECONCILED_OUTPUT');
        });

        it('caps the reveal fee output at the quoted amount', async function () {
            const err = await chunkedError('P2SH', 10_000, { amount: 5_000 });
            assert.strictEqual(err && err.code, 'OUTPUT_OVER_REQUESTED_VALUE');
        });
    });
});
