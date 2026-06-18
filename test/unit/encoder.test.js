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
const EncoderClient = require('../../src/encoder.js');

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

    /*
     *  createTx
     */

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

    /*
     *  spendP2sh
     */

    describe('spendP2sh', function () {
        it('sends correct payload with empty data', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('create_tx');
                    expect(body.params.data).to.equal('');
                    expect(body.params.pubkey).to.equal('pub');
                    expect(body.params.p2shHash).to.equal('hash123');
                    expect(body.params.p2shHex).to.equal('rawhex');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            let result = await client.spendP2sh({ pubkey: 'pub', p2shHash: 'hash123', p2shHex: 'rawhex' });
            expect(result.psbt).to.equal('hex');
        });

        it('throws on missing pubkey', async function () {
            try {
                await client.spendP2sh({ p2shHash: 'h', p2shHex: 'x' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_PUBKEY');
            }
        });

        it('throws on missing p2shHash', async function () {
            try {
                await client.spendP2sh({ pubkey: 'pub', p2shHex: 'x' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_P2SH_HASH');
            }
        });

        it('throws on missing p2shHex', async function () {
            try {
                await client.spendP2sh({ pubkey: 'pub', p2shHash: 'h' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_P2SH_HEX');
            }
        });
    });

    /*
     *  ping
     */

    describe('ping', function () {
        it('returns success result', async function () {
            nock(BASE)
                .post('/', (body) => body.method === 'ping')
                .reply(200, { jsonrpc: '2.0', result: { status: 'success' }, id: 1 });

            let result = await client.ping();
            expect(result.status).to.equal('success');
        });
    });

    /*
     *  Error handling
     */

    describe('error handling', function () {
        it('wraps HTTP errors', async function () {
            nock(BASE).post('/').reply(500, 'Internal Server Error');
            try {
                await client.createTx({ data: 'TEST', pubkey: 'pub' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_HTTP_500');
            }
        });

        it('wraps network errors', async function () {
            nock(BASE).post('/').replyWithError('connection refused');
            try {
                await client.createTx({ data: 'TEST', pubkey: 'pub' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_NETWORK');
            }
        });
    });

    /*
     *  RPC ID incrementing
     */

    describe('RPC ID', function () {
        it('increments with each call', async function () {
            let ids = [];
            nock(BASE)
                .post('/', (body) => { ids.push(body.id); return true; })
                .reply(200, { jsonrpc: '2.0', result: { status: 'success' }, id: 1 })
                .post('/', (body) => { ids.push(body.id); return true; })
                .reply(200, { jsonrpc: '2.0', result: { status: 'success' }, id: 2 });

            await client.ping();
            await client.ping();
            expect(ids[1]).to.be.greaterThan(ids[0]);
        });
    });

    /*
     *  broadcastTx
     */

    describe('broadcastTx', function () {
        it('sends broadcast_tx RPC with tx_hex', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('broadcast_tx');
                    expect(body.params.tx_hex).to.equal('deadbeef');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { txid: 'abc123' }, id: 1 });

            let result = await client.broadcastTx('deadbeef');
            expect(result.txid).to.equal('abc123');
        });

        it('throws on missing txHex', async function () {
            try {
                await client.broadcastTx('');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('MISSING_TX_HEX');
            }
        });

        it('throws on null txHex', async function () {
            try {
                await client.broadcastTx(null);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_TX_HEX');
            }
        });
    });

    /*
     *  getUTXOs
     */

    describe('getUTXOs', function () {
        it('sends get_utxos RPC with address', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('get_utxos');
                    expect(body.params.address).to.equal('addr1');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { utxos: [{ txid: 'tx1', vout: 0, value: 10000 }] }, id: 1 });

            let result = await client.getUTXOs('addr1');
            expect(result.utxos).to.have.length(1);
            expect(result.utxos[0].txid).to.equal('tx1');
        });

        it('throws on missing address', async function () {
            try {
                await client.getUTXOs('');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('MISSING_ADDRESS');
            }
        });

        it('throws on null address', async function () {
            try {
                await client.getUTXOs(null);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_ADDRESS');
            }
        });
    });

    /*
     *  estimateFee
     */

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

        it('propagates createTx errors', async function () {
            try {
                await client.estimateFee({ pubkey: 'pub' }); // missing data
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_DATA');
            }
        });
    });

    /*
     *  spendP2sh optional params
     */

    describe('spendP2sh optional params', function () {
        it('passes encoding, rawData, compressedPubKey, change, fee, feePerKb, rbf, dust, unconfirmed', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.encoding).to.equal('P2WSH');
                    expect(body.params.rawData).to.equal('rawbytes');
                    expect(body.params.compressedPubKey).to.equal('02abc');
                    expect(body.params.change).to.equal('chaddr');
                    expect(body.params.fee).to.equal(500);
                    expect(body.params.feePerKb).to.equal(20000);
                    expect(body.params.rbf).to.equal(true);
                    expect(body.params.dust).to.equal(300);
                    expect(body.params.unconfirmed).to.equal(false);
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2WSH' }, id: 1 });

            let result = await client.spendP2sh({
                pubkey: 'pub',
                p2shHash: 'hash',
                p2shHex: 'rawhex',
                data: 'ACTION',
                encoding: 'p2wsh',
                rawData: 'rawbytes',
                compressedPubKey: '02abc',
                change: 'chaddr',
                fee: 500,
                feePerKb: 20000,
                rbf: true,
                dust: 300,
                unconfirmed: false
            });
            expect(result.psbt).to.equal('hex');
        });

        it('passes explicit data when provided', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.data).to.equal('MYACTION');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            await client.spendP2sh({ pubkey: 'pub', p2shHash: 'h', p2shHex: 'x', data: 'MYACTION' });
        });
    });

    /*
     *  setBase
     */

    describe('setBase', function () {
        it('no-ops when both url and port are falsy', function () {
            const origClient = client.client;
            client.setBase(null, null);
            expect(client.client).to.equal(origClient);
        });

        it('no-ops when url/port unchanged', function () {
            const origClient = client.client;
            client.setBase('encoder.test', 3000);
            expect(client.client).to.equal(origClient);
        });

        it('rebuilds client when url changes', function () {
            const origClient = client.client;
            client.setBase('new-encoder.test', 3000);
            expect(client.client).to.not.equal(origClient);
            expect(client.baseUrl).to.equal('new-encoder.test');
        });

        it('rebuilds client when port changes', function () {
            const origClient = client.client;
            client.setBase('encoder.test', 4000);
            expect(client.client).to.not.equal(origClient);
            expect(client.port).to.equal(4000);
        });
    });

    /*
     *  hooks
     */

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onRequest hook', async function () {
            const onRequest = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onRequest }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onRequest.calledOnce).to.be.true;
            expect(onRequest.firstCall.args[0].service).to.equal('encoder');
            expect(onRequest.firstCall.args[0].method).to.equal('ping');
        });

        it('fires onResponse hook', async function () {
            const onResponse = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onResponse }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onResponse.calledOnce).to.be.true;
            expect(onResponse.firstCall.args[0].service).to.equal('encoder');
        });

        it('fires onError hook on RPC error', async function () {
            const onError = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onError }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', error: { code: -1, message: 'oops' }, id: 1 });

            try {
                await hooked.ping();
            } catch (e) {
                // expected
            }
            expect(onError.calledOnce).to.be.true;
            expect(onError.firstCall.args[0].service).to.equal('encoder');
        });

        it('fires onError hook on network error', async function () {
            const onError = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onError }
            });
            nock(BASE)
                .post('/')
                .replyWithError('connection reset');

            try {
                await hooked.ping();
            } catch (e) {
                // expected
            }
            expect(onError.calledOnce).to.be.true;
        });

        it('fires onRetry hook on retryable error', async function () {
            const onRetry = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: { maxRetries: 1, baseDelay: 0, maxDelay: 0, backoffFactor: 1 },
                hooks: { onRetry }
            });

            // First call fails with 503 (retryable), second succeeds
            nock(BASE)
                .post('/')
                .reply(503, 'Service Unavailable')
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onRetry.calledOnce).to.be.true;
            expect(onRetry.firstCall.args[0].service).to.equal('encoder');
        });
    });

    /*
     *  readyHook
     */

    describe('readyHook', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('awaits readyHook before each RPC call', async function () {
            let hookCalled = false;
            const readyHook = async () => { hookCalled = true; };
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                readyHook
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(hookCalled).to.be.true;
        });
    });

    /*
     *  retry=false disables retries
     */

    describe('retry=false', function () {
        it('does not retry when retry is false', async function () {
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false
            });

            // Only intercept one call; if retried, nock would throw unmatched request
            nock(BASE)
                .post('/')
                .reply(503, 'Service Unavailable');

            try {
                await hooked.ping();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_HTTP_503');
            }
        });
    });

    /*
     *  ECONNABORTED timeout error
     */

    describe('timeout errors', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('wraps ECONNABORTED as ENCODER_TIMEOUT', async function () {
            // Use a no-retry client so the test completes immediately
            const noRetry = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false
            });
            const err = new Error('timeout of 30000ms exceeded');
            err.code = 'ECONNABORTED';
            sinon.stub(noRetry.client, 'post').rejects(err);
            try {
                await noRetry.ping();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('ENCODER_TIMEOUT');
                expect(e.details.timeout).to.equal(noRetry.timeout);
            }
        });
    });

    /*
     *  estimateFee: nonWitnessUtxo path (legacy inputs)
     */

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

    /*
     *  HTTPS base URL
     */

    describe('HTTPS base URL', function () {
        it('builds client with https agent when url starts with https', function () {
            const hooked = new EncoderClient({
                encoderUrl: 'https://encoder.example.com',
                encoderPort: 443
            });
            expect(hooked.client.defaults.baseURL).to.equal('https://encoder.example.com');
        });
    });

    /*
     *  Public methods
     */

    describe('public methods', function () {
        it('has 7 public methods', function () {
            let methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            expect(methods).to.have.length(7);
            expect(methods).to.include('ping');
            expect(methods).to.include('createTx');
            expect(methods).to.include('spendP2sh');
            expect(methods).to.include('broadcastTx');
            expect(methods).to.include('getUTXOs');
            expect(methods).to.include('estimateFee');
            expect(methods).to.include('setBase');
        });
    });

});
