'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('node:crypto');
const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const { decodeActionStringFromPsbt } = require('../../../src/cosigner/psbt_action_decode.js');
const { rawDataMatches } = require('../../../src/carrier/verify_carrier_scripts.js');

const NET = bitcoin.networks.regtest;
const PREV_TXID = '1f'.repeat(16) + '2e'.repeat(16);
const SOURCE_HASH = Buffer.alloc(20, 0xab);

function opReturnFor(actionString, rawData) {
    const pushes = [Buffer.from(actionString, 'utf8')];
    if (rawData !== undefined) pushes.push(Buffer.from(rawData));
    const plain = Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile(pushes)]);
    const cipher = crypto.createCipheriv('aes-128-ctr', PREV_TXID.slice(0, 16), PREV_TXID.slice(16, 32));
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_RETURN,
        Buffer.concat([cipher.update(plain), cipher.final()]),
    ]);
}

function psbtFor(actionString, rawData) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
        hash: PREV_TXID,
        index: 0,
        witnessUtxo: {
            script: bitcoin.payments.p2wpkh({ hash: SOURCE_HASH, network: NET }).output,
            value: 100000n,
        },
    });
    psbt.addOutput({ script: opReturnFor(actionString, rawData), value: 0n });
    return psbt.toHex();
}

describe('inline rawData binding on real PSBT bytes', function () {
    it('accepts the approved payload and rejects altered or missing payload pushes', function () {
        const actionString = 'FILE|0|proof.txt|text/plain|';
        const approved = Buffer.from('approved file bytes');
        const decodedGood = decodeActionStringFromPsbt(psbtFor(actionString, approved));
        const decodedAltered = decodeActionStringFromPsbt(psbtFor(actionString, 'altered file bytes'));
        const decodedMissing = decodeActionStringFromPsbt(psbtFor(actionString));

        expect(decodedGood).to.include({ ok: true, actionString });
        expect(decodedGood.pushes).to.have.length(2);
        expect(rawDataMatches(decodedGood.pushes, approved, false)).to.equal(true);
        expect(rawDataMatches(decodedAltered.pushes, approved, false)).to.equal(false);
        expect(rawDataMatches(decodedMissing.pushes, approved, false)).to.equal(false);
    });
});
