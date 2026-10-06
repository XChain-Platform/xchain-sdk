// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The gate must judge the prevout the key signs. bitcoinjs signs an input
// against its hash-checked nonWitnessUtxo whenever one is present, so a
// witnessUtxo that disagrees with it is a forgery the gate must refuse, not
// a script it may read: read naively, it lets a hostile encoder pass an
// attacker output off as change, or understate the input to slip the fee guard.

const assert  = require('assert');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { reconcileEncoded, psbtPrevouts } = require('../../../../src/carrier/reconcile_encoded.js');
require('../../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;
const VALUE = 100000;

// A fresh single-key P2PKH destination.
function p2pkh() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    return bitcoin.payments.p2pkh({ pubkey, network: NET }).output;
}

const carrier = () => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });

// The wallet's real UTXO, as the full previous transaction bitcoinjs signs against.
function previousTx(script) {
    const tx = new bitcoin.Transaction();
    tx.addInput(crypto.randomBytes(32), 0);
    tx.addOutput(script, VALUE);
    return tx;
}

// One wallet input carrying the real nonWitnessUtxo plus whatever witnessUtxo the encoder chose.
function psbtFor(prev, witnessUtxo, outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    const input = { hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer() };
    if (witnessUtxo) input.witnessUtxo = witnessUtxo;
    psbt.addInput(input);
    for (const out of outputs) psbt.addOutput(out);
    return psbt.toHex();
}

describe('reconcileEncoded prevout field conflicts', function () {
    it('REJECTS a drain whose forged witnessUtxo names the attacker script as the funding input', function () {
        const wallet = p2pkh(), attacker = p2pkh();
        const hex = psbtFor(previousTx(wallet), { script: attacker, value: VALUE },
            [carrier(), { script: attacker, value: VALUE - 1000 }]);
        assert.throws(() => reconcileEncoded(hex, { network: NET }), (e) => e.code === 'INCONSISTENT_PREVOUT');
    });

    it('REJECTS an understated witnessUtxo value that would slip the fee cap', function () {
        const wallet = p2pkh();
        const hex = psbtFor(previousTx(wallet), { script: wallet, value: 1000 },
            [carrier(), { script: wallet, value: 900 }]);
        assert.throws(() => reconcileEncoded(hex, { network: NET, maxFeeSats: 5000 }),
                      (e) => e.code === 'INCONSISTENT_PREVOUT');
    });

    it('REJECTS a nonWitnessUtxo that is not the transaction the input spends', function () {
        const wallet = p2pkh();
        const psbt = bitcoin.Psbt.fromHex(psbtFor(previousTx(wallet), null, [carrier(), { script: wallet, value: 99000 }]));
        psbt.data.inputs[0].nonWitnessUtxo = previousTx(wallet).toBuffer();
        assert.throws(() => reconcileEncoded(psbt.toHex(), { network: NET }), (e) => e.code === 'INCONSISTENT_PREVOUT');
        assert.strictEqual(psbtPrevouts(psbt.toHex()), null);
    });

    it('still reconciles change when both fields carry the same prevout, or only the full transaction', function () {
        const wallet = p2pkh(), prev = previousTx(wallet);
        const outs = [carrier(), { script: wallet, value: 99000 }];
        assert.strictEqual(reconcileEncoded(psbtFor(prev, { script: wallet, value: VALUE }, outs), { network: NET }).fee, 1000n);
        assert.strictEqual(reconcileEncoded(psbtFor(prev, null, outs), { network: NET }).fee, 1000n);
    });
});
