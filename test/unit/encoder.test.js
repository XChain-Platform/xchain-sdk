const { expect } = require('chai');
const nock = require('nock');
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
     *  Public methods
     */

    describe('public methods', function () {
        it('has 5 public methods', function () {
            let methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
                .filter(m => !m.startsWith('_') && m !== 'constructor');
            expect(methods).to.have.length(5);
            expect(methods).to.include('ping');
            expect(methods).to.include('createTx');
            expect(methods).to.include('spendP2sh');
            expect(methods).to.include('broadcastTx');
            expect(methods).to.include('getUTXOs');
        });
    });

});
