// Copyright 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const zlib = require('zlib');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const { assertCarrierBinding } = require('../../../../src/carrier/bind_action_carrier.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin;
const OWN = bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom().publicKey, network: NET }).output;
const RAW_ACTION = 'FILE|0|report.bin|application/octet-stream';
const COMPRESSED_ACTION = RAW_ACTION + '|||||||1';

function carrierScript(prevHash, action, rawData) {
    const pushes = [Buffer.from(action, 'utf8')];
    if (rawData !== undefined) pushes.push(rawData);
    const plain = Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile(pushes)]);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.slice(0, 16), txid.slice(16, 32));
    const encoded = Buffer.concat([cipher.update(plain), cipher.final()]);
    return bitcoin.payments.embed({ data: [encoded] }).output;
}

function inlinePsbt(action, rawData) {
    const prevHash = crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000n } });
    psbt.addOutput({ script: carrierScript(prevHash, action, rawData), value: 0n });
    psbt.addOutput({ script: OWN, value: 90000n });
    return psbt;
}

function bind(psbt, action, rawData) {
    return () => assertCarrierBinding({ psbt, actionString: action, rawData,
        encoding: 'OP_RETURN', network: NET, label: 'transaction' });
}

describe('inline carrier rawData binding', function () {
    const bytes = Buffer.from('small file bytes');

    it('accepts matching bytes and keeps omitted rawData backward compatible', function () {
        expect(bind(inlinePsbt(RAW_ACTION, bytes), RAW_ACTION, bytes)).to.not.throw();
        expect(bind(inlinePsbt(RAW_ACTION, bytes), RAW_ACTION, undefined)).to.not.throw();
        expect(bind(inlinePsbt(RAW_ACTION), RAW_ACTION, null)).to.not.throw();
    });

    it('refuses an added, dropped, or substituted second push', function () {
        expect(bind(inlinePsbt(RAW_ACTION, bytes), RAW_ACTION, null)).to.throw(/does not carry/);
        expect(bind(inlinePsbt(RAW_ACTION), RAW_ACTION, bytes)).to.throw(/does not carry/);
        expect(bind(inlinePsbt(RAW_ACTION, Buffer.from('other')), RAW_ACTION, bytes))
            .to.throw(/does not carry/);
    });

    it('requires compressed action bytes to carry compressed rawData', function () {
        const large = Buffer.from('a'.repeat(200));
        expect(bind(inlinePsbt(COMPRESSED_ACTION, zlib.deflateRawSync(large)), RAW_ACTION, large))
            .to.not.throw();
        expect(bind(inlinePsbt(COMPRESSED_ACTION, large), RAW_ACTION, large))
            .to.throw(/does not carry/);
    });
});

describe('inline carrier compression tolerance stays on FILE v0', function () {
    const MANIFEST = 'FILE|1|' + 'ab'.repeat(32) + '|3|900|a.bin|application/octet-stream|T|M';
    const MANIFEST_COMPRESSED = MANIFEST + '|||||1';

    it('refuses a v1 manifest rewritten to declare COMPRESSION', function () {
        expect(bind(inlinePsbt(MANIFEST_COMPRESSED), MANIFEST, null)).to.throw(/does not carry/);
    });

    it('accepts a v1 manifest carried exactly as submitted', function () {
        expect(bind(inlinePsbt(MANIFEST_COMPRESSED), MANIFEST_COMPRESSED, null)).to.not.throw();
    });
});
