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
// A multisig PSBT is written by the coordinator, not by this cosigner. If the
// cosigner's key also controls a plain single-key UTXO, a coordinator can mix
// that UTXO into the spend; signing it hands its value to outputs the
// coordinator chose. signMultisigPsbt must sign only multisig inputs whose
// script names this key, and only the inputs the caller lists when it does.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../../src/utils/wallet.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');

const NET_NAME = 'bitcoin-regtest';
const VALUE = 100_000;

// A fresh previous transaction paying `script`, so every input has its own prevout.
function prevTxPaying(script, salt) {
    const tx = new bitcoin.Transaction();
    tx.addInput(Buffer.alloc(32, salt), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    tx.addOutput(script, VALUE);
    return tx;
}

// The key pair's public key as a Buffer.
function pub(kp) {
    return Buffer.from(kp.publicKey);
}

// Input builders, one per script shape; each returns the bitcoinjs input object.
function makeInputBuilders(net) {
    let salt = 1;
    return {
        p2wshMulti(keys, m) {
            const redeem = bitcoin.payments.p2ms({ m, pubkeys: keys.map(pub), network: net });
            const p2wsh = bitcoin.payments.p2wsh({ redeem, network: net });
            const prev = prevTxPaying(p2wsh.output, salt++);
            return { hash: prev.getId(), index: 0, witnessUtxo: { script: p2wsh.output, value: VALUE }, witnessScript: redeem.output };
        },
        p2shP2wshMulti(keys, m) {
            const redeem = bitcoin.payments.p2ms({ m, pubkeys: keys.map(pub), network: net });
            const p2wsh = bitcoin.payments.p2wsh({ redeem, network: net });
            const p2sh = bitcoin.payments.p2sh({ redeem: p2wsh, network: net });
            const prev = prevTxPaying(p2sh.output, salt++);
            return { hash: prev.getId(), index: 0, witnessUtxo: { script: p2sh.output, value: VALUE }, redeemScript: p2wsh.output, witnessScript: redeem.output };
        },
        p2shMulti(keys, m) {
            const redeem = bitcoin.payments.p2ms({ m, pubkeys: keys.map(pub), network: net });
            const p2sh = bitcoin.payments.p2sh({ redeem, network: net });
            const prev = prevTxPaying(p2sh.output, salt++);
            return { hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer(), redeemScript: redeem.output };
        },
        p2wpkh(kp) {
            const out = bitcoin.payments.p2wpkh({ pubkey: pub(kp), network: net }).output;
            const prev = prevTxPaying(out, salt++);
            return { hash: prev.getId(), index: 0, witnessUtxo: { script: out, value: VALUE } };
        },
        p2pkh(kp) {
            const out = bitcoin.payments.p2pkh({ pubkey: pub(kp), network: net }).output;
            const prev = prevTxPaying(out, salt++);
            return { hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer() };
        },
        p2shP2wpkh(kp) {
            const redeem = bitcoin.payments.p2wpkh({ pubkey: pub(kp), network: net });
            const p2sh = bitcoin.payments.p2sh({ redeem, network: net });
            const prev = prevTxPaying(p2sh.output, salt++);
            return { hash: prev.getId(), index: 0, witnessUtxo: { script: p2sh.output, value: VALUE }, redeemScript: redeem.output };
        },
    };
}

function setup() {
    const wallet = new WalletUtils(NET_NAME);
    const net = getNetwork(NET_NAME);
    const a = wallet.generateKeyPair();
    const b = wallet.generateKeyPair();
    const c = wallet.generateKeyPair();
    const inputs = makeInputBuilders(net);

    const build = (list) => {
        const psbt = new bitcoin.Psbt({ network: net });
        for (const input of list) psbt.addInput(Object.assign({ sequence: 0xfffffffd }, input));
        const sink = bitcoin.payments.p2wpkh({ pubkey: pub(c), network: net }).output;
        psbt.addOutput({ script: sink, value: VALUE });
        return psbt.toHex();
    };

    // Which inputs carry a partial signature from `kp`.
    const signedBy = (psbtHex, kp) => bitcoin.Psbt.fromHex(psbtHex, { network: net }).data.inputs.map(
        (inp) => (inp.partialSig || []).some((ps) => Buffer.from(ps.pubkey).equals(pub(kp))));

    return { wallet, a, b, c, inputs, build, signedBy };
}

describe('WalletUtils signMultisigPsbt input scope', function () {
    it('signs the multisig input and leaves single-key inputs to the same key unsigned', function () {
        const { wallet, a, b, inputs, build, signedBy } = setup();
        const psbtHex = build([
            inputs.p2wshMulti([a, b], 2),
            inputs.p2wpkh(a),
            inputs.p2pkh(a),
            inputs.p2shP2wpkh(a),
        ]);
        const out = wallet.signMultisigPsbt(psbtHex, a.wif);
        expect(signedBy(out.psbtHex, a)).to.deep.equal([true, false, false, false]);
    });

    it('signs every classical multisig shape: P2WSH, P2SH-P2WSH and bare P2SH', function () {
        const { wallet, a, b, inputs, build, signedBy } = setup();
        const psbtHex = build([inputs.p2wshMulti([a, b], 2), inputs.p2shP2wshMulti([a, b], 2), inputs.p2shMulti([a, b], 2)]);
        expect(signedBy(wallet.signMultisigPsbt(psbtHex, a.wif).psbtHex, a)).to.deep.equal([true, true, true]);
    });

    it('ignores a decoy multisig script attached to a single-key input', function () {
        const { wallet, a, b, inputs, build, signedBy } = setup();
        const decoy = bitcoin.payments.p2ms({ m: 1, pubkeys: [Buffer.from(a.publicKey), Buffer.from(b.publicKey)] }).output;
        const psbtHex = build([
            inputs.p2wshMulti([a, b], 2),
            Object.assign(inputs.p2wpkh(a), { witnessScript: decoy }),
            Object.assign(inputs.p2pkh(a), { redeemScript: decoy }),
        ]);
        const out = wallet.signMultisigPsbt(psbtHex, a.wif);
        expect(signedBy(out.psbtHex, a)).to.deep.equal([true, false, false]);
        expect(() => wallet.signMultisigPsbt(psbtHex, a.wif, { inputIndices: [1] }))
            .to.throw(/input #1 is not a multisig input for this key/);
    });

    it('refuses a PSBT that holds no multisig input for this key', function () {
        const { wallet, a, inputs, build } = setup();
        const psbtHex = build([inputs.p2wpkh(a), inputs.p2pkh(a)]);
        expect(() => wallet.signMultisigPsbt(psbtHex, a.wif)).to.throw().with.property('code', 'SIGN_FAILED');
    });
});

describe('WalletUtils signMultisigPsbt input scope', function () {
    it('does not sign a multisig input whose script lacks this key', function () {
        const { wallet, a, b, c, inputs, build, signedBy } = setup();
        const mixed = build([inputs.p2wshMulti([b, c], 2), inputs.p2wshMulti([a, b], 2)]);
        expect(signedBy(wallet.signMultisigPsbt(mixed, a.wif).psbtHex, a)).to.deep.equal([false, true]);
        const foreignOnly = build([inputs.p2wshMulti([b, c], 2)]);
        expect(() => wallet.signMultisigPsbt(foreignOnly, a.wif)).to.throw().with.property('code', 'SIGN_FAILED');
    });

    it('signs only the listed inputs when opts.inputIndices is given', function () {
        const { wallet, a, b, c, inputs, build, signedBy } = setup();
        const psbtHex = build([inputs.p2wshMulti([a, b], 2), inputs.p2wshMulti([a, c], 2)]);
        const out = wallet.signMultisigPsbt(psbtHex, a.wif, { inputIndices: [1] });
        expect(signedBy(out.psbtHex, a)).to.deep.equal([false, true]);
    });

    it('refuses an inputIndices entry that names a single-key input', function () {
        const { wallet, a, b, inputs, build } = setup();
        const psbtHex = build([inputs.p2wshMulti([a, b], 2), inputs.p2wpkh(a)]);
        expect(() => wallet.signMultisigPsbt(psbtHex, a.wif, { inputIndices: [0, 1] }))
            .to.throw(/input #1 is not a multisig input for this key/).with.property('code', 'SIGN_FAILED');
    });

    it('refuses an empty, out-of-range or non-integer inputIndices', function () {
        const { wallet, a, b, inputs, build } = setup();
        const psbtHex = build([inputs.p2wshMulti([a, b], 2)]);
        expect(() => wallet.signMultisigPsbt(psbtHex, a.wif, { inputIndices: [] }))
            .to.throw().with.property('code', 'SIGN_FAILED');
        for (const bad of [[1], [-1], [0.5], ['0']]) {
            expect(() => wallet.signMultisigPsbt(psbtHex, a.wif, { inputIndices: bad }), JSON.stringify(bad))
                .to.throw().with.property('code', 'INVALID_INPUT');
        }
    });
});
