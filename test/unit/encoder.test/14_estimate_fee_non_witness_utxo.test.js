// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const nock = require('nock');
const sinon = require('sinon');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('estimateFee nonWitnessUtxo', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('computes fee using nonWitnessUtxo (legacy input)', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const ECPair = ECPairFactory(ecc);

            const net = bitcoin.networks.regtest;
            const kp = ECPair.makeRandom({ network: net });
            const p2pkh = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: net });

            // Build a funding tx
            const fundTx = new bitcoin.Transaction();
            fundTx.addInput(Buffer.alloc(32), 0, 0xffffffff, Buffer.from([0x51]));
            fundTx.addOutput(p2pkh.output, 200000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash: fundTx.getId(),
                index: 0,
                sequence: 0xfffffffd,
                nonWitnessUtxo: fundTx.toBuffer()
            });
            psbt.addOutput({ script: p2pkh.output, value: 180000 });
            const psbtHex = psbt.toHex();

            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: psbtHex, encoding: 'OP_RETURN' }, id: 1 });

            let result = await client.estimateFee({ data: 'TEST', pubkey: 'pub' });
            expect(result.inputTotal).to.equal(200000);
            expect(result.outputTotal).to.equal(180000);
            expect(result.fee).to.equal(20000);
        });
    });
});
