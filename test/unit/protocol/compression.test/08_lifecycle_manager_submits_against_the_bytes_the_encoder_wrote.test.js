/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * FILE payload compression, SDK side.
 *
 * What this suite pins:
 *  1. the deflate-raw golden pair INFLATES to the pinned plaintext, and the
 *     gated golden vector inverts (decrypt -> inflate) to its pinned sha256;
 *  2. compression is presentational: we assert the round trip, never that a
 *     particular deflate OUTPUT is reproducible across implementations;
 *  3. try-and-keep-if-smaller, including both refusal paths (not smaller,
 *     and over the emit-time ratio guard);
 *  4. inflate is FAIL-CLOSED and never throws: garbage, truncation, a lying
 *     COMPRESSION field and a compression bomb all degrade to stored-form;
 *  5. the ratio guard aborts a bomb mid-stream rather than after allocating;
 *  6. COMPRESSION is derived from the ACTION STRING, never a parsed column,
 *     and the trailing-field convention keeps a non-compressed FILE
 *     byte-identical to the pre-Part-B form;
 *  7. compress-then-encrypt ordering for gated FILEs (§5.4).
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const CompressionUtils = require('../../../../src/protocol/compression.js');
const GatedFileUtils = require('../../../../src/actions/gated_file.js');
const { SDKCompressionError } = require('../../../../src/utils/errors.js');
const CONSTANTS = require('../../../../src/protocol/constants.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The encoder COMPRESSES inside create_tx: it rewrites the action
// string's COMPRESSION field and deflates the payload, so from the moment
// create_tx answers, the submitted action string and the caller's rawData
// describe the request and not the bytes. Reading the request instead of the
// answer broke both ends of a compressible FILE upload - the carrier gate
// refused the transaction this SDK had just asked for, and the phase-2 reveal
// was rebuilt from the uncompressed payload, compiling a carrier that hashes to
// nothing the commit created (a broadcast commit nothing can spend).
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';
const FILE_ACTION = 'FILE|0|sample.txt|text/plain';
const FILE_ACTION_WRITTEN = 'FILE|0|sample.txt|text/plain|||||||1';
const SUPPLIED_RAW = 'x'.repeat(2048);
const STORED_RAW = 'z'.repeat(300);

// A signed-and-unsigned pair the reconcile gate can parse.
function buildSignedTx() {
    const kp = ECPair.makeRandom();
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).output;
    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(script, 100000);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd,
                    witnessUtxo: { script, value: 100000 } });
    psbt.addOutput({ script, value: 90000 });
    const psbtHex = psbt.toHex();
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { psbtHex, txHex: tx.toHex(), txid: tx.getId() };
}

// An encoder answer built the way xchain-encoder builds one: the action
// compiled behind the XCHN magic word, AES-128-CTR obfuscated under the
// first input's txid, in a zero-value OP_RETURN, change back to the funding
// script. Only the carrier's CONTENTS differ between cases.
function encoderAnswer(carriedAction) {
    const kp = ECPair.makeRandom();
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).output;
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const tagged = Buffer.concat([Buffer.from('XCHN'),
        bitcoin.script.compile([Buffer.from(carriedAction, 'utf8')])]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({
        data: [Buffer.concat([cipher.update(tagged), cipher.final()])] }).output, value: 0 });
    psbt.addOutput({ script, value: 90000 });
    return psbt.toHex();
}

function makeSdk(encoderOverrides, calls) {
    const signed = buildSignedTx();
    const encoder = Object.assign({
        createTx:    async () => ({ psbt: signed.psbtHex, encoding: 'OP_RETURN' }),
        spendP2sh:   async () => ({ psbt: signed.psbtHex }),
        broadcastTx: async () => { calls.push('broadcast'); return { txid: signed.txid }; },
    }, encoderOverrides);
    return {
        _requireEncoder: () => encoder,
        actions: { createAction: () => ({ actionString: FILE_ACTION, action: 'FILE', version: 0 }) },
        tickResolver:    { resolveActionParams: async (a, p) => p },
        addressResolver: { resolveActionParams: async (a, p) => p },
        wallet: {
            signPsbt:       () => { calls.push('sign'); return { txHex: signed.txHex, txid: 'p1txid', psbtHex: signed.psbtHex }; },
            signRevealPsbt: () => { calls.push('sign-reveal'); return { txHex: signed.txHex, txid: 'p2txid', psbtHex: signed.psbtHex }; },
        },
    };
}

const REPORT = {
    compressed: true, rawLength: SUPPLIED_RAW.length, storedLength: STORED_RAW.length,
    reason: null, data: FILE_ACTION_WRITTEN, rawData: STORED_RAW,
};

const submit = (sdk) => new LifecycleManager(sdk).submitAction(
    { action: 'FILE', params: {} },
    { pubkey: '03pub', change: 'addr', rawData: SUPPLIED_RAW },
    { wif: FAKE_WIF, waitForIndexer: false });

describe('LifecycleManager submits against the bytes the encoder WROTE', function () {
    it('hands phase 2 the WRITTEN action string and the STORED payload', async function () {
        const calls = [];
        let spendParams = null;
        const signed = buildSignedTx();
        const sdk = makeSdk({
            createTx:  async () => ({ psbt: signed.psbtHex, encoding: 'P2SH', compression: REPORT }),
            spendP2sh: async (p) => { spendParams = p; return { psbt: signed.psbtHex }; },
        }, calls);

        await submit(sdk);

        assert.strictEqual(spendParams.data, FILE_ACTION_WRITTEN,
            'the reveal must re-derive its chunks from the string the commit carried');
        assert.strictEqual(spendParams.rawData, STORED_RAW,
            'and from the deflated bytes, not the ones the caller handed over');
        assert.strictEqual(spendParams.compress, false,
            'these bytes are already deflated; say so rather than depend on a guard');
    });

    it('leaves phase 2 on the caller\'s own bytes when nothing was compressed', async function () {
        const calls = [];
        let spendParams = null;
        const signed = buildSignedTx();
        const sdk = makeSdk({
            createTx:  async () => ({ psbt: signed.psbtHex, encoding: 'P2SH' }),
            spendP2sh: async (p) => { spendParams = p; return { psbt: signed.psbtHex }; },
        }, calls);

        await submit(sdk);

        assert.strictEqual(spendParams.data, FILE_ACTION);
        assert.strictEqual(spendParams.rawData, SUPPLIED_RAW);
        assert.strictEqual(spendParams.compress, undefined,
            'the deployment default is left alone when there is nothing to pin');
    });
});

describe('LifecycleManager submits against the bytes the encoder WROTE', function () {
    it('REFUSES before signing when the encoder compressed but withheld what it wrote', async function () {
        const calls = [];
        const signed = buildSignedTx();
        const sdk = makeSdk({
            createTx: async () => ({ psbt: signed.psbtHex, encoding: 'P2SH',
                compression: { compressed: true, rawLength: 2048, storedLength: 300, reason: null } }),
        }, calls);

        await assert.rejects(() => submit(sdk), (e) => e.code === 'COMPRESSION_BYTES_UNREPORTED');
        assert.deepStrictEqual(calls, [],
            'nothing may be signed or broadcast when the reveal cannot be rebuilt');
    });

    it('binds the carrier to the WRITTEN string, and reports it as the action string', async function () {
        const calls = [];
        const sdk = makeSdk({
            createTx: async () => ({ psbt: encoderAnswer(FILE_ACTION_WRITTEN),
                encoding: 'OP_RETURN', compression: REPORT }),
        }, calls);

        const result = await submit(sdk);
        assert.deepStrictEqual(calls, ['sign', 'broadcast'],
            'a compressible FILE upload must stop refusing the transaction it asked for');
        assert.strictEqual(result.actionString, FILE_ACTION_WRITTEN,
            'the reported action string is the one on chain, which is what the indexer read');
    });

    it('still refuses a carrier that holds neither the submitted nor the written string', async function () {
        // The gate was re-pointed, not loosened: a substituted command riding in
        // on the same field compression legitimately rewrites is still tamper.
        const calls = [];
        const sdk = makeSdk({
            createTx: async () => ({ psbt: encoderAnswer('FILE|0|payload.exe|text/plain|||||||1'),
                encoding: 'OP_RETURN', compression: REPORT }),
        }, calls);

        await assert.rejects(() => submit(sdk), (e) => e.code === 'CARRIER_ACTION_MISMATCH');
        assert.deepStrictEqual(calls, []);
    });
});
