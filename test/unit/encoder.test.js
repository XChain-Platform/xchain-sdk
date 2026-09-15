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
const EncoderClient = require('../../src/clients/encoder.js');

describe('EncoderClient', function () {

    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({
            encoderUrl: 'encoder.test',
            encoderPort: 3000
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('createTx', function () {
        it('sends correct JSON-RPC payload', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.jsonrpc).to.equal('2.0');
                    expect(body.method).to.equal('create_tx');
                    expect(body.params.data).to.equal('SEND|0|TOKEN|100|addr1');
                    expect(body.params.pubkey).to.equal('mypubkey');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'aabbcc', encoding: 'OP_RETURN' }, id: 1 });

            let result = await client.createTx({ data: 'SEND|0|TOKEN|100|addr1', pubkey: 'mypubkey' });
            expect(result.psbt).to.equal('aabbcc');
            expect(result.encoding).to.equal('OP_RETURN');
        });

        it('passes all optional params', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.encoding).to.equal('P2SH');
                    expect(body.params.fee).to.equal(1000);
                    expect(body.params.rbf).to.equal(true);
                    expect(body.params.dust).to.equal(546);
                    expect(body.params.unconfirmed).to.equal(false);
                    expect(body.params.feePerKb).to.equal(50000);
                    expect(body.params.change).to.equal('changeAddr');
                    expect(body.params.compressedPubKey).to.equal('02abc');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            await client.createTx({
                data: 'TEST', pubkey: 'pub',
                encoding: 'p2sh', fee: 1000, rbf: true, dust: 546,
                unconfirmed: false, feePerKb: 50000, change: 'changeAddr',
                compressedPubKey: '02abc'
            });
        });
    });

});

describe('EncoderClient', function () {

    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({
            encoderUrl: 'encoder.test',
            encoderPort: 3000
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('createTx', function () {
        it('uppercases encoding', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.encoding).to.equal('OP_RETURN');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'OP_RETURN' }, id: 1 });

            await client.createTx({ data: 'TEST', pubkey: 'pub', encoding: 'op_return' });
        });

        it('omits undefined optional params', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params).to.not.have.property('encoding');
                    expect(body.params).to.not.have.property('fee');
                    expect(body.params).to.not.have.property('rbf');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'OP_RETURN' }, id: 1 });

            await client.createTx({ data: 'TEST', pubkey: 'pub' });
        });
    });

});

describe('EncoderClient', function () {

    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({
            encoderUrl: 'encoder.test',
            encoderPort: 3000
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('createTx', function () {
        it('throws on missing data', async function () {
            try {
                await client.createTx({ pubkey: 'pub' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('MISSING_DATA');
            }
        });

        it('throws on missing pubkey', async function () {
            try {
                await client.createTx({ data: 'TEST' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_PUBKEY');
            }
        });

        it('wraps RPC error response', async function () {
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', error: { code: -32000, message: 'Insufficient UTXOs' }, id: 1 });

            try {
                await client.createTx({ data: 'TEST', pubkey: 'pub' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_RPC_ERROR');
                expect(e.message).to.include('Insufficient UTXOs');
            }
        });
    });

});
