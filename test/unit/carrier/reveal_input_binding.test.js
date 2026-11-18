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
 * A P2SH/P2WSH chunk reveal is decoded from the leading push of every input
 * script in input order, so the inputs that carry scripts must be exactly the
 * carrier legs phase 1 verified, in order, spending the signed commit, and none
 * may arrive already signed. Real PSBTs, both encodings, through the checker and
 * through the phase-2 path that must run it before the reveal is signed.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { ECPair } = require('../../../src/utils/wallet/key_derivation.js');
const { assertRevealInputsBound } = require('../../../src/carrier/bind_reveal_inputs.js');
const { prepareChunkReveal } = require('../../../src/carrier/lifecycle_manager/submission_results.js');

const NET = bitcoin.networks.regtest;
const H160 = Buffer.alloc(20, 0xab);
const DEST = bitcoin.payments.p2wpkh({ hash: H160, network: NET });
const LEG_VALUE = 10000;

function redeemFor(chunk) {
    return bitcoin.script.compile([chunk, bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160, H160, bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]);
}

function legOutput(encoding, redeem) {
    const pay = encoding === 'P2SH' ? bitcoin.payments.p2sh : bitcoin.payments.p2wsh;
    return pay({ redeem: { output: redeem }, network: NET }).output;
}

// A signed commit with one funding leg per chunk, then change, and the matching scripts.
function commitFor(encoding, chunks = 3) {
    const redeems = Array.from({ length: chunks }, (_, i) => redeemFor(Buffer.alloc(30, i + 1)));
    const commit = new bitcoin.Transaction();
    commit.addInput(crypto.randomBytes(32), 0);
    for (const redeem of redeems) commit.addOutput(legOutput(encoding, redeem), LEG_VALUE);
    commit.addOutput(DEST.output, 50000);
    return { commit, redeems, carrierScripts: redeems.map(r => r.toString('hex')) };
}

function legInput(encoding, commit, index, redeem, extra = {}) {
    const out = commit.outs[index];
    const input = { hash: commit.getHash(), index, sequence: 0xfffffffd, ...extra };
    if (encoding === 'P2SH') Object.assign(input, { redeemScript: redeem, nonWitnessUtxo: commit.toBuffer() });
    else Object.assign(input, { witnessScript: redeem, witnessUtxo: { script: out.script, value: out.value } });
    return input;
}

function revealFor(inputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    for (const { partialSig, ...input } of inputs) psbt.addInput(input);
    psbt.addOutput({ script: DEST.output, value: inputs.length * LEG_VALUE - 1000 });
    inputs.forEach(({ partialSig }, i) => { if (partialSig) psbt.updateInput(i, { partialSig }); });
    return psbt;
}

function honestInputs(encoding, fixture) {
    return fixture.redeems.map((redeem, i) => legInput(encoding, fixture.commit, i, redeem));
}

function bound(encoding, fixture, inputs, overrides = {}) {
    return () => assertRevealInputsBound({ psbt: revealFor(inputs).toHex(), commitTxHex: fixture.commit.toHex(),
        carrierScripts: fixture.carrierScripts, encoding, network: NET, ...overrides });
}

const refusedFor = reason => error => error.code === 'REVEAL_INPUTS_REFUSED' && error.details.reason === reason;

function foreignLeg(encoding, redeem, extra = {}) {
    const other = commitFor(encoding, 1);
    return legInput(encoding, other.commit, 0, redeem, extra);
}

const PARTIAL = [{ pubkey: ECPair.fromPrivateKey(Buffer.alloc(32, 5)).publicKey,
    signature: bitcoin.script.signature.encode(Buffer.alloc(64, 1), bitcoin.Transaction.SIGHASH_ALL) }];

for (const encoding of ['P2SH', 'P2WSH']) {
    describe(`${encoding} chunk reveal inputs are bound to the verified carrier legs`, function () {
        it('accepts a reveal that spends each leg once, in order', function () {
            const fixture = commitFor(encoding);
            assert.doesNotThrow(bound(encoding, fixture, honestInputs(encoding, fixture)));
        });

        it('refuses reordered legs', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            [inputs[0], inputs[1]] = [inputs[1], inputs[0]];
            assert.throws(bound(encoding, fixture, inputs), refusedFor('INPUT_OUTPUT_NOT_COMMITTED_TO_SCRIPT'));
        });

        it('refuses a foreign input carrying a script and a partial signature', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            inputs.splice(1, 0, foreignLeg(encoding, redeemFor(Buffer.alloc(30, 9)), { partialSig: PARTIAL }));
            assert.throws(bound(encoding, fixture, inputs), refusedFor('PRESIGNED_INPUT'));
        });

        it('refuses an extra unsigned input that carries a script', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            inputs.push(foreignLeg(encoding, redeemFor(Buffer.alloc(30, 9))));
            assert.throws(bound(encoding, fixture, inputs), refusedFor('EXTRA_DATA_INPUT'));
        });

        it('refuses a reveal that leaves a verified leg unspent', function () {
            const fixture = commitFor(encoding);
            assert.throws(bound(encoding, fixture, honestInputs(encoding, fixture).slice(0, 2)),
                refusedFor('CARRIER_LEG_NOT_SPENT'));
        });

        it('refuses a genuine leg that arrives with a partial signature', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            inputs[1] = legInput(encoding, fixture.commit, 1, fixture.redeems[1], { partialSig: PARTIAL });
            assert.throws(bound(encoding, fixture, inputs), refusedFor('PRESIGNED_INPUT'));
        });

        it('refuses a leg whose script differs from the verified carrier', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            inputs[2] = legInput(encoding, fixture.commit, 2, redeemFor(Buffer.alloc(30, 9)));
            assert.throws(bound(encoding, fixture, inputs), refusedFor('INPUT_SCRIPT_MISMATCH'));
        });

        it('refuses an input that spends a different transaction', function () {
            const fixture = commitFor(encoding);
            const inputs = honestInputs(encoding, fixture);
            inputs[0] = foreignLeg(encoding, fixture.redeems[0]);
            assert.throws(bound(encoding, fixture, inputs), refusedFor('INPUT_NOT_FROM_COMMIT'));
        });

        it('refuses a script-bearing input when no carrier scripts were verified', function () {
            const fixture = commitFor(encoding);
            assert.throws(bound(encoding, fixture, honestInputs(encoding, fixture), { carrierScripts: undefined }),
                refusedFor('EXTRA_DATA_INPUT'));
        });
    });
}

function phaseTwoState(encoding, fixture, inputs, signReveal) {
    const psbt = revealFor(inputs);
    return { manager: { reconcileNetwork: () => NET, sdk: { wallet: { signRevealPsbt: signReveal } } },
        state: { encoder: { spendP2sh: async () => ({ psbt: psbt.toHex() }) },
            signed: { txid: fixture.commit.getId(), txHex: fixture.commit.toHex() },
            encoded: { encoding, carrierScripts: fixture.carrierScripts },
            encoderOpts: { pubkey: '02aa' }, carriedAction: {},
            reconcileState: { reconcileIntent: { network: NET },
                revealCustomOutputs: [{ address: DEST.address, value: inputs.length * LEG_VALUE - 1000 }],
                phase1: { phaseFunding: [] } },
            createResult: { actionString: 'SEND|0|TOK|1|dest|m' }, wif: 'unused', progress: () => {} } };
}

for (const encoding of ['P2SH', 'P2WSH']) {
    describe(`${encoding} phase-2 path signs only a reveal bound to the verified legs`, function () {
        it('signs an honest reveal and refuses a reordered one before signing', async function () {
            const fixture = commitFor(encoding);
            const signed = [];
            const sign = psbt => { signed.push(psbt); return { txHex: 'aa', txid: 'bb' }; };
            const honest = phaseTwoState(encoding, fixture, honestInputs(encoding, fixture), sign);
            await prepareChunkReveal(honest.manager, honest.state);
            assert.strictEqual(signed.length, 1);
            const inputs = honestInputs(encoding, fixture).reverse();
            const swapped = phaseTwoState(encoding, fixture, inputs, sign);
            await assert.rejects(() => prepareChunkReveal(swapped.manager, swapped.state),
                error => error.code === 'REVEAL_INPUTS_REFUSED');
            assert.strictEqual(signed.length, 1);
        });
    });
}
