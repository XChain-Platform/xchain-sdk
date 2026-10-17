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

// A chunked (P2SH/P2WSH) action is two transactions, and the commit strands its
// value if the reveal is then refused. So the reveal is built from the signed
// commit, reconciled, bound and signed before the commit is broadcast, and a
// refused reveal means nothing is broadcast at all. The reveal request also
// carries every createTx option the caller set, the hub feeQuote among them.

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const { FAKE_WIF, buildSignedTx, makeSdk } = require('./helpers/lifecycle_manager.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin; // the fake SDK reconciles on the bitcoinjs default network

// An unsigned reveal-shaped PSBT: one input, an empty OP_RETURN, and `outputs`.
function revealPsbt(outputs) {
    const kp = ECPair.makeRandom({ network: NET });
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: NET }).output;
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: 'ab'.repeat(32), index: 0, witnessUtxo: { script, value: 100_000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]), value: 0 });
    for (const out of outputs(script)) psbt.addOutput(out);
    return psbt.toHex();
}

function hubAddress() {
    return bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom({ network: NET }).publicKey, network: NET }).address;
}

// Run submitAction on a P2WSH answer, recording every encoder and wallet call in order.
// failRevealBroadcast makes the second broadcast (the reveal) fail.
function submit(revealHex, encoderOpts, failRevealBroadcast) {
    const calls = [];
    const signed = buildSignedTx();
    let spendParams = null;
    const sdk = makeSdk({
        wallet: {
            signPsbt:       () => { calls.push('sign'); return { txHex: signed.txHex, txid: 'p1', psbtHex: signed.psbtHex }; },
            signRevealPsbt: () => { calls.push('sign-reveal'); return { txHex: 'reveal-hex', txid: 'p2', psbtHex: revealHex }; },
        },
    }, {
        createTx:    async () => { calls.push('createTx'); return { psbt: signed.psbtHex, encoding: 'P2WSH' }; },
        spendP2sh:   async (p) => { calls.push('spendP2sh'); spendParams = p; return { psbt: revealHex }; },
        broadcastTx: async () => {
            calls.push('broadcast');
            if (failRevealBroadcast && calls.filter((c) => c === 'broadcast').length === 2) throw new Error('node said no');
            return {};
        },
    });
    const run = new LifecycleManager(sdk).submitAction(
        { action: 'SEND', params: {} }, Object.assign({ pubkey: '03pub', change: 'addr' }, encoderOpts),
        { wif: FAKE_WIF, waitForIndexer: false });
    return { run, calls, params: () => spendParams };
}

describe('LifecycleManager', function () {
    describe('submitAction(): the reveal exists before the commit is broadcast', function () {
        it('broadcasts nothing when the reveal would be refused as a full burn', async function () {
            const { run, calls } = submit(revealPsbt(() => []), {});
            await assert.rejects(run, (e) => e.code === 'FULL_BURN_FEE');
            assert.ok(!calls.includes('broadcast'), 'calls: ' + calls.join(' -> '));
        });

        it('builds and signs the reveal before the commit broadcast, then broadcasts both', async function () {
            const { run, calls } = submit(revealPsbt((script) => [{ script, value: 90_000 }]), {});
            await run;
            assert.deepStrictEqual(calls, ['createTx', 'sign', 'spendP2sh', 'sign-reveal', 'broadcast', 'broadcast']);
        });

        it('hands back the signed reveal when its broadcast fails after the commit', async function () {
            const { run } = submit(revealPsbt((script) => [{ script, value: 90_000 }]), {}, true);
            await assert.rejects(run, (e) => e.code === 'CHUNK_REVEAL_BROADCAST_FAILED'
                && e.details.revealTxHex === 'reveal-hex' && e.details.commitTxid === 'p1');
        });
    });

    describe('submitAction(): the reveal request carries the caller\'s createTx options', function () {
        it('forwards the hub feeQuote and accepts the reveal output it pays', async function () {
            const address = hubAddress();
            const feeQuote = { address, amount: 10_000 };
            const reveal = revealPsbt((script) => [{ address, value: 10_000 }, { script, value: 80_000 }]);
            const { run, params } = submit(reveal, { feeQuote });
            const result = await run;
            assert.strictEqual(result.txid, 'p2');
            assert.deepStrictEqual(params().feeQuote, feeQuote);
        });

        it('forwards every createTx option a reveal takes, and not utxos, sourceAddress or options', async function () {
            const opts = { fee: 900, feePerKb: 2000, rbf: true, dust: 600, unconfirmed: false,
                compressedPubKey: '02' + '11'.repeat(32), attachPrevTx: true, options: { exactInputs: true },
                utxos: [{ txid: 'cd'.repeat(32), vout: 0, value: 1, scriptPubKey: '00' }], sourceAddress: 'addr' };
            const { run, params } = submit(revealPsbt((script) => [{ script, value: 90_000 }]), opts);
            await run;
            for (const key of ['fee', 'feePerKb', 'rbf', 'dust', 'unconfirmed', 'compressedPubKey', 'attachPrevTx'])
                assert.deepStrictEqual(params()[key], opts[key], key);
            assert.strictEqual(params().utxos, undefined, 'a reveal selects no funding inputs');
            assert.strictEqual(params().sourceAddress, undefined);
            assert.strictEqual(params().options, undefined, 'the encoder refuses exactInputs beside p2shHash');
            assert.strictEqual(params().encoding, 'P2WSH');
        });
    });
});
