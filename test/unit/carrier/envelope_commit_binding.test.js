'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPair } = require('../../../src/utils/wallet/key_derivation.js');
const { assertEnvelopeCommitBinding } = require('../../../src/carrier/bind_action_carrier.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;
const CALLER = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: NET });
const ATTACKER = ECPair.fromPrivateKey(Buffer.alloc(32, 8), { network: NET });
const CALLER_X = Buffer.from(CALLER.publicKey).subarray(1, 33);
const ATTACKER_X = Buffer.from(ATTACKER.publicKey).subarray(1, 33);

function leafFor(key = CALLER_X) {
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_0, bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN'), Buffer.from([0]), Buffer.from('SEND|0|XCHAIN|1|dest'),
        bitcoin.opcodes.OP_ENDIF, key, bitcoin.opcodes.OP_CHECKSIG,
    ]);
}

function pairFor({ internal = CALLER_X, leaf = leafFor(), sibling = null } = {}) {
    const tree = sibling ? [{ output: leaf }, { output: sibling }] : { output: leaf };
    const commitPayment = bitcoin.payments.p2tr({ internalPubkey: internal, scriptTree: tree, network: NET });
    const revealPayment = bitcoin.payments.p2tr({
        internalPubkey: internal, scriptTree: tree,
        redeem: { output: leaf, redeemVersion: 0xc0 }, network: NET,
    });
    const funding = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(CALLER.publicKey), network: NET });
    const commit = new bitcoin.Psbt({ network: NET });
    commit.addInput({ hash: Buffer.alloc(32, 1), index: 0,
        witnessUtxo: { script: funding.output, value: 100000 } });
    commit.addOutput({ script: commitPayment.output, value: 50000 });
    commit.addOutput({ script: funding.output, value: 49000 });
    const commitTx = commit.__CACHE.__TX;
    const reveal = new bitcoin.Psbt({ network: NET });
    reveal.addInput({ hash: commitTx.getId(), index: 0,
        witnessUtxo: { script: commitPayment.output, value: 50000 },
        tapInternalKey: internal,
        tapLeafScript: [{ leafVersion: 0xc0, script: leaf,
            controlBlock: revealPayment.witness[revealPayment.witness.length - 1] }],
    });
    reveal.addOutput({ script: funding.output, value: 49000 });
    return { commit, reveal };
}

function bind(pair) {
    return () => assertEnvelopeCommitBinding({
        commitPsbt: pair.commit, revealPsbt: pair.reveal,
        callerXOnly: CALLER_X, network: NET,
    });
}

describe('single-WIF envelope commit binding', function () {
    it('accepts an honest single-leaf commit/reveal pair', function () {
        const result = assertEnvelopeCommitBinding({
            commitPsbt: pairFor().commit,
            revealPsbt: pairFor().reveal,
            callerXOnly: CALLER_X,
            network: NET,
        });
        expect(Buffer.from(result.script)).to.have.length(34);
        expect(result.value).to.equal(50000n);
    });

    it('refuses an attacker internal key and a hidden sibling leaf', function () {
        expect(bind(pairFor({ internal: ATTACKER_X }))).to.throw(/caller-owned commit output/);
        expect(bind(pairFor({ sibling: bitcoin.script.compile([ATTACKER_X, bitcoin.opcodes.OP_CHECKSIG]) })))
            .to.throw(/caller-owned commit output/);
    });

    it('refuses a leaf whose checksig key is not the caller key', function () {
        expect(bind(pairFor({ internal: ATTACKER_X, leaf: leafFor(ATTACKER_X) })))
            .to.throw(/caller-owned commit output/);
    });

    it('refuses a reveal whose first input does not spend the returned commit', function () {
        const pair = pairFor();
        pair.reveal.__CACHE.__TX.ins[0].hash = Buffer.alloc(32, 9);
        expect(bind(pair)).to.throw(/caller-owned commit output/);
    });

    it('refuses any second reveal input spending another output of the commit', function () {
        const pair = pairFor();
        const commitTx = pair.commit.__CACHE.__TX;
        const change = pair.commit.txOutputs[1];
        pair.reveal.addInput({ hash: commitTx.getId(), index: 1,
            witnessUtxo: { script: change.script, value: change.value } });
        expect(bind(pair)).to.throw(/caller-owned commit output/);
    });
});
