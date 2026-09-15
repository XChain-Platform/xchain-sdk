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
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

// The encoder is a REMOTE service that chooses the bytes this SDK signs.
// reconcileEncoded proves the coin still goes where the caller asked and never
// reads the data carrier, so a response with identical outputs and an identical
// fee could still carry a different COMMAND, and this path signed it.

const SUBMITTED   = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';
const SUBSTITUTED = 'SEND|0|TOK|1000|1RecipientBBBBBBBBBBBBBBBBBBBBBBBB|m';

// An encoder answer built the way xchain-encoder builds one: the action
// compiled behind the XCHN magic word, AES-128-CTR obfuscated under the
// first input's txid, in a zero-value OP_RETURN, with change back to the
// funding script. Only the carrier's CONTENTS differ between the two cases.
function encoderAnswer(carriedAction) {
    const bitcoin = require('bitcoinjs-lib');
    const crypto  = require('crypto');
    const ecc     = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const kp = ECPairFactory(ecc).makeRandom();
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).output;
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const tagged = Buffer.concat([Buffer.from('XCHN'),
        bitcoin.script.compile([Buffer.from(carriedAction, 'utf8')])]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script, value: 100_000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({
        data: [Buffer.concat([cipher.update(tagged), cipher.final()])] }).output, value: 0 });
    psbt.addOutput({ script, value: 90_000 });
    return psbt.toHex();
}

function sdkFor(carriedAction, calls) {
    return makeSdk({
        actions: { createAction: () => ({ actionString: SUBMITTED, action: 'SEND', version: 0 }) },
        wallet:  { signPsbt: () => { calls.push('sign'); return { txHex: '00', txid: 'signedtxid', psbtHex: '00' }; } },
    }, {
        createTx:    async () => ({ psbt: encoderAnswer(carriedAction), encoding: 'OP_RETURN' }),
        broadcastTx: async () => { calls.push('broadcast'); return { txid: 'signedtxid' }; },
    });
}

// The compression report is the encoder's own claim about its own answer,
// so it cannot be allowed to REPLACE the thing being authorized. Feeding
// the gate `compression.data` made it compare the encoder's transaction
// against the encoder's own intent, and a substituted SEND with a matching
// report passed. The gate reads the SUBMITTED string instead.
function sdkForReported(carriedAction, reported, calls) {
    return makeSdk({
        actions: { createAction: () => ({ actionString: SUBMITTED, action: 'SEND', version: 0 }) },
        wallet:  { signPsbt: () => { calls.push('sign'); return { txHex: '00', txid: 'signedtxid', psbtHex: '00' }; } },
    }, {
        createTx:    async () => ({
            psbt: encoderAnswer(carriedAction), encoding: 'OP_RETURN',
            compression: { compressed: true, data: reported, rawData: '' },
        }),
        broadcastTx: async () => { calls.push('broadcast'); return { txid: 'signedtxid' }; },
    });
}

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): the carrier must hold the action that was submitted", function () {
        it('refuses a substituted amount and destination BEFORE anything is signed', async function () {
            const calls = [];
            const lm = new LifecycleManager(sdkFor(SUBSTITUTED, calls));
            await assert.rejects(
                () => lm.submitAction({ action: 'SEND', params: {} }, { pubkey: '03pub' },
                    { wif: FAKE_WIF, waitForIndexer: false }),
                (e) => e.code === 'CARRIER_ACTION_MISMATCH');
            assert.deepStrictEqual(calls, [],
                'the substituted command must be refused before any key touches it');
        });

        // The control: the identical shape, carrying what was actually submitted,
        // still signs and broadcasts. Without it the refusal above would only prove
        // the path throws.
        it('signs and broadcasts when the carrier holds exactly what was submitted', async function () {
            const calls = [];
            const lm = new LifecycleManager(sdkFor(SUBMITTED, calls));
            const result = await lm.submitAction({ action: 'SEND', params: {} }, { pubkey: '03pub' },
                { wif: FAKE_WIF, waitForIndexer: false });
            assert.strictEqual(result.txid, 'signedtxid');
            assert.deepStrictEqual(calls, ['sign', 'broadcast']);
        });
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): the carrier must hold the action that was submitted", function () {
        it('refuses a substitution the encoder also declares in compression.data', async function () {
            const calls = [];
            // Both halves of the answer are the attacker's: the carrier holds the
            // substituted SEND and the report declares that same string.
            const lm = new LifecycleManager(sdkForReported(SUBSTITUTED, SUBSTITUTED, calls));
            await assert.rejects(
                () => lm.submitAction({ action: 'SEND', params: {} }, { pubkey: '03pub' },
                    { wif: FAKE_WIF, waitForIndexer: false }),
                (e) => e.code === 'CARRIER_ACTION_MISMATCH');
            assert.deepStrictEqual(calls, [],
                'a self-consistent encoder answer is still not an authorization');
        });

        // The legitimate case the tolerance exists for: a FILE v0 whose COMPRESSION
        // field the caller left empty and the encoder set. The gate recomputes that
        // one rewrite locally, so this still signs, and result.actionString reports
        // the bytes that are ON CHAIN rather than the ones submitted.
        it('still signs a genuinely compressed FILE and reports the on-chain string', async function () {
            const calls = [];
            const Compression = require('../../../src/protocol/compression.js');
            const submittedFile = 'FILE|0|doc.txt|text/plain|aaa|bbb|TOK|||';
            const compressedFile = new Compression().withCompressionField(submittedFile, '1');
            assert.notStrictEqual(compressedFile, submittedFile);
            const sdk = makeSdk({
                actions: { createAction: () => ({ actionString: submittedFile, action: 'FILE', version: 0 }) },
                wallet:  { signPsbt: () => { calls.push('sign'); return { txHex: '00', txid: 'signedtxid', psbtHex: '00' }; } },
            }, {
                createTx:    async () => ({
                    psbt: encoderAnswer(compressedFile), encoding: 'OP_RETURN',
                    compression: { compressed: true, data: compressedFile, rawData: 'deflated' },
                }),
                broadcastTx: async () => { calls.push('broadcast'); return { txid: 'signedtxid' }; },
            });
            const result = await new LifecycleManager(sdk).submitAction(
                { action: 'FILE', params: {} }, { pubkey: '03pub' },
                { wif: FAKE_WIF, waitForIndexer: false });
            assert.deepStrictEqual(calls, ['sign', 'broadcast']);
            assert.strictEqual(result.actionString, compressedFile);
        });
    });
});
