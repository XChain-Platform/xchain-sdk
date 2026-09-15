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

    describe('estimateFee', function () {
        it('returns feeInfo with fee=null and parseError when psbt is garbage', async function () {
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'notavalidpsbt', encoding: 'OP_RETURN' }, id: 1 });

            let result = await client.estimateFee({ data: 'TEST', pubkey: 'pub' });
            expect(result.psbt).to.equal('notavalidpsbt');
            expect(result.encoding).to.equal('OP_RETURN');
            expect(result.fee).to.equal(null);
            expect(result.parseError).to.be.a('string');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('estimateFee', function () {
        it('returns feeInfo with computed fee from a valid PSBT', async function () {
            // Build a minimal valid PSBT using bitcoinjs-lib
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const ECPair = ECPairFactory(ecc);

            const net = bitcoin.networks.regtest;
            const kp = ECPair.makeRandom({ network: net });
            const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;

            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(script, 100000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash: prevTx.getId(),
                index: 0,
                sequence: 0xfffffffd,
                witnessUtxo: { script, value: 100000 }
            });
            psbt.addOutput({ script, value: 90000 });
            const psbtHex = psbt.toHex();

            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: psbtHex, encoding: 'OP_RETURN' }, id: 1 });

            let result = await client.estimateFee({ data: 'TEST', pubkey: 'pub' });
            expect(result.psbt).to.equal(psbtHex);
            expect(result.inputTotal).to.equal(100000);
            expect(result.outputTotal).to.equal(90000);
            expect(result.fee).to.equal(10000);
        });
    });
});

describe('EncoderClient', function () {
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('estimateFee', function () {
        it('propagates createTx errors', async function () {
            try {
                await client.estimateFee({ pubkey: 'pub' }); // missing data
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_DATA');
            }
        });
    });
});
