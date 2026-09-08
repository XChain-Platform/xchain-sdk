// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The two batch reads and the POST transport under them. A wallet polling five
// addresses on three chains spends one request per chain per poll here instead
// of one per address, so what these tests pin is the wire: the body that goes
// out, the paging that must still ride along, the refusals that never leave the
// process, and the three failures a caller has to tell apart (an explorer too
// old to have the route, a rate limit, and everything else).

const { expect } = require('chai');
const nock = require('nock');
const sinon = require('sinon');
const ExplorerClient = require('../../src/explorer.js');
const XChainSDK = require('../../src/XChainSDK.js');
const { SDKExplorerError, SDKRateLimitedError } = require('../../src/errors.js');

describe('ExplorerClient batch reads', function () {

    const BASE = 'http://explorer.test:8080';
    const OPTS = {
        network: 'bitcoin-mainnet',
        explorerUrl: 'explorer.test',
        explorerPort: 8080,
        retry: false
    };
    let client;

    beforeEach(function () {
        client = new ExplorerClient(OPTS);
    });

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });


    describe('the request that goes out', function () {

        it('getBalancesBatch posts { addresses } and answers the address-keyed body', async function () {
            const body = {
                a1: { balances: { total: 2, data: [{ tick: 'XCP' }] }, address: { address: 'a1' }, error: null },
                a2: { balances: null, address: null, error: { code: 'EXPLORER_HTTP_500', error: 'boom', status: 500 } }
            };
            const scope = nock(BASE).post('/BTC/api/balances', { addresses: ['a1', 'a2'] }).reply(200, body);
            const result = await client.getBalancesBatch(['a1', 'a2']);
            expect(scope.isDone()).to.equal(true);
            expect(result).to.deep.equal(body);
        });

        it('getCoinpayObligationsBatch posts { addresses } and answers the address-keyed body', async function () {
            const body = {
                a1: { coinpay_obligations: { total: 1, data: [{ amount: '5' }] }, error: null },
                a2: { coinpay_obligations: { total: 0, data: [] }, error: null }
            };
            const scope = nock(BASE).post('/BTC/api/coinpay_obligations', { addresses: ['a1', 'a2'] }).reply(200, body);
            const result = await client.getCoinpayObligationsBatch(['a1', 'a2']);
            expect(scope.isDone()).to.equal(true);
            expect(result).to.deep.equal(body);
        });

        it('forwards the paging query params to the batch route, so paging parity with the per-address read holds', async function () {
            const scope = nock(BASE)
                .post('/BTC/api/balances', { addresses: ['a1'] })
                .query({ limit: '5', page: '2' })
                .reply(200, { a1: { balances: { total: 99, data: [] }, address: null, error: null } });
            const result = await client.getBalancesBatch(['a1'], { limit: 5, page: 2 });
            expect(scope.isDone()).to.equal(true);
            expect(result.a1.balances.total).to.equal(99);
        });

        it('keeps noRetry out of the query string (it is a client knob, not a param)', async function () {
            const scope = nock(BASE)
                .post('/BTC/api/balances', { addresses: ['a1'] })
                .query({})
                .reply(200, { a1: { balances: null, address: null, error: null } });
            await client.getBalancesBatch(['a1'], { noRetry: true });
            expect(scope.isDone()).to.equal(true);
        });

        it('carries the coin prefix of the client network', async function () {
            const regtest = new ExplorerClient(Object.assign({}, OPTS, { network: 'bitcoin-regtest' }));
            const scope = nock(BASE).post('/RBTC/api/coinpay_obligations', { addresses: ['a1'] }).reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
            await regtest.getCoinpayObligationsBatch(['a1']);
            expect(scope.isDone()).to.equal(true);
        });

        it('awaits the readiness hook before posting, like the GET path does', async function () {
            const order = [];
            const hooked = new ExplorerClient(Object.assign({}, OPTS, {
                readyHook: async () => { order.push('ready'); }
            }));
            nock(BASE).post('/BTC/api/balances').reply(200, function () { order.push('request'); return { a1: { balances: null, address: null, error: null } }; });
            await hooked.getBalancesBatch(['a1']);
            expect(order).to.deep.equal(['ready', 'request']);
        });

        it('records the freshness marker off a batch response', async function () {
            nock(BASE).post('/BTC/api/balances').reply(200, { a1: { balances: null, address: null, error: null } }, {
                'XChain-Freshness': 'stale',
                'XChain-Tip-Block': '840000',
                'XChain-Tip-Age-S': '900'
            });
            await client.getBalancesBatch(['a1']);
            const fresh = client.freshness();
            expect(fresh.stale).to.equal(true);
            expect(fresh.tipBlock).to.equal(840000);
            expect(fresh.tipAgeSeconds).to.equal(900);
        });
    });


    describe('client-side refusals (no request leaves the process)', function () {

        // Every one of these registers a mock that must still be pending when
        // the call throws: a refusal that costs a request is not a refusal.
        const bad = {
            'an empty array':          [],
            'a non-array (null)':      null,
            'a non-array (undefined)': undefined,
            'a non-array (string)':    'a1',
            'a non-array (object)':    { addresses: ['a1'] },
            'a non-string entry':      ['a1', 42],
            'a nested array entry':    ['a1', ['a2']],
            '21 addresses':            Array.from({ length: 21 }, (_, i) => 'a' + i)
        };

        for (const [label, input] of Object.entries(bad)) {
            it('refuses ' + label + ' with INVALID_ADDRESSES, before any request', async function () {
                const balances = nock(BASE).post('/BTC/api/balances').reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
                const coinpay  = nock(BASE).post('/BTC/api/coinpay_obligations').reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
                let thrownA, thrownB;
                try { await client.getBalancesBatch(input); } catch (e) { thrownA = e; }
                try { await client.getCoinpayObligationsBatch(input); } catch (e) { thrownB = e; }
                for (const thrown of [thrownA, thrownB]) {
                    expect(thrown, 'should have thrown').to.be.an('error');
                    expect(thrown).to.be.instanceof(SDKExplorerError);
                    expect(thrown.code).to.equal('INVALID_ADDRESSES');
                    expect(thrown.message).to.equal('addresses must be a non-empty array of at most 20 address strings');
                }
                expect(thrownA.details.count).to.equal(Array.isArray(input) ? input.length : null);
                expect(balances.isDone(), 'no balances request may be sent').to.equal(false);
                expect(coinpay.isDone(), 'no coinpay request may be sent').to.equal(false);
            });
        }

        it('accepts exactly 20 addresses, the boundary the explorer accepts', async function () {
            const twenty = Array.from({ length: 20 }, (_, i) => 'a' + i);
            const scope = nock(BASE).post('/BTC/api/balances', { addresses: twenty }).reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
            await client.getBalancesBatch(twenty);
            expect(scope.isDone()).to.equal(true);
        });
    });


    describe('failures a caller has to tell apart', function () {

        it('an explorer without the route answers 404, and it surfaces as EXPLORER_HTTP_404 (the feature-detection signal)', async function () {
            nock(BASE).post('/BTC/api/balances').reply(404, 'Cannot POST /BTC/api/balances');
            let thrown;
            try { await client.getBalancesBatch(['a1']); } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKExplorerError);
            expect(thrown.code).to.equal('EXPLORER_HTTP_404');
            expect(thrown.details.status).to.equal(404);
            expect(thrown.message).to.equal('Explorer returned HTTP 404 for /BTC/api/balances');
        });

        it('an older explorer answers the POST with a JSON-RPC error at HTTP 200, and it surfaces as EXPLORER_BATCH_UNSUPPORTED', async function () {
            // Measured on a live explorer that predates the route: every unknown
            // POST lands on its JSON-RPC router, which answers this object at 200.
            const rpcError = { error: { code: -32600, message: 'Invalid Request, wrong version - undefined' }, id: null };
            nock(BASE).post('/BTC/api/balances').reply(200, rpcError);
            nock(BASE).post('/BTC/api/coinpay_obligations').reply(200, rpcError);
            for (const call of [() => client.getBalancesBatch(['a1']), () => client.getCoinpayObligationsBatch(['a1'])]) {
                let thrown;
                try { await call(); } catch (e) { thrown = e; }
                expect(thrown).to.be.instanceof(SDKExplorerError);
                expect(thrown.code).to.equal('EXPLORER_BATCH_UNSUPPORTED');
                expect(thrown.details.data).to.deep.equal(rpcError);
            }
        });

        it('a 200 that carries the requested addresses is the route, whatever else it carries', async function () {
            nock(BASE).post('/BTC/api/balances').reply(200, { a1: { balances: null, address: null, error: { code: 'DB_ERROR', error: 'x', status: 500 } } });
            const body = await client.getBalancesBatch(['a1']);
            expect(body.a1.error.code).to.equal('DB_ERROR');
        });

        it('a 429 surfaces as SDKRateLimitedError only after the honoured Retry-After wait', async function () {
            const limited = new ExplorerClient(Object.assign({}, OPTS, {
                // Tiny caps so the honoured wait is real but costs milliseconds.
                retry: { maxRetries: 2, baseDelay: 0, maxDelay: 0, backoffFactor: 1, retryAfterMaxDelay: 20, maxRateLimitRetries: 1 }
            }));
            const first  = nock(BASE).post('/BTC/api/balances').reply(429, { error: 'slow down' }, { 'Retry-After': '2' });
            const second = nock(BASE).post('/BTC/api/balances').reply(429, { error: 'slow down' }, { 'Retry-After': '2' });
            let thrown;
            try { await limited.getBalancesBatch(['a1']); } catch (e) { thrown = e; }
            expect(first.isDone(), 'the first 429 must have been retried').to.equal(true);
            expect(second.isDone(), 'the retry must have been sent').to.equal(true);
            expect(thrown).to.be.instanceof(SDKRateLimitedError);
            expect(thrown.code).to.equal('RATE_LIMITED');
            expect(thrown.retryAfterSeconds).to.equal(2);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/balances; retry after 2 seconds');
        });

        it('a 429 that the retry clears returns the body', async function () {
            const retrying = new ExplorerClient(Object.assign({}, OPTS, {
                retry: { maxRetries: 2, baseDelay: 0, maxDelay: 0, backoffFactor: 1, retryAfterMaxDelay: 20, maxRateLimitRetries: 1 }
            }));
            nock(BASE).post('/BTC/api/coinpay_obligations').reply(429, {}, { 'Retry-After': '1' });
            nock(BASE).post('/BTC/api/coinpay_obligations').reply(200, { a1: { coinpay_obligations: { total: 3, data: [] }, error: null } });
            const result = await retrying.getCoinpayObligationsBatch(['a1']);
            expect(result.a1.coinpay_obligations.total).to.equal(3);
        });

        it('a transport failure surfaces as EXPLORER_NETWORK', async function () {
            nock(BASE).post('/BTC/api/balances').replyWithError('connection reset');
            let thrown;
            try { await client.getBalancesBatch(['a1']); } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKExplorerError);
            expect(thrown.code).to.equal('EXPLORER_NETWORK');
        });

        it('a coin gate 503 surfaces with its status, so the caller can back off the whole chain', async function () {
            nock(BASE).post('/BTC/api/balances').reply(503, { code: 'COIN_UNAVAILABLE', error: 'coin down' });
            let thrown;
            try { await client.getBalancesBatch(['a1']); } catch (e) { thrown = e; }
            expect(thrown.code).to.equal('EXPLORER_HTTP_503');
            expect(thrown.details.data.code).to.equal('COIN_UNAVAILABLE');
        });
    });


    describe('hooks', function () {

        it('onRequest and onResponse report method POST', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient(Object.assign({}, OPTS, { hooks: { onRequest, onResponse } }));
            nock(BASE).post('/BTC/api/balances').reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
            await hooked.getBalancesBatch(['a1']);
            expect(onRequest.calledOnce).to.be.true;
            expect(onRequest.firstCall.args[0]).to.include({ service: 'explorer', method: 'POST', url: '/BTC/api/balances' });
            expect(onResponse.calledOnce).to.be.true;
            expect(onResponse.firstCall.args[0]).to.include({ service: 'explorer', method: 'POST', status: 200 });
        });

        it('onError reports method POST', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient(Object.assign({}, OPTS, { hooks: { onError } }));
            nock(BASE).post('/BTC/api/coinpay_obligations').replyWithError('network down');
            try { await hooked.getCoinpayObligationsBatch(['a1']); } catch (e) { /* expected */ }
            expect(onError.calledOnce).to.be.true;
            expect(onError.firstCall.args[0]).to.include({ service: 'explorer', method: 'POST', url: '/BTC/api/coinpay_obligations' });
        });

        it('onRetry reports method POST and the status that caused the retry', async function () {
            const onRetry = sinon.spy();
            const hooked = new ExplorerClient(Object.assign({}, OPTS, {
                retry: { maxRetries: 1, baseDelay: 0, maxDelay: 0, backoffFactor: 1 },
                hooks: { onRetry }
            }));
            nock(BASE).post('/BTC/api/balances').reply(503, 'unavailable');
            nock(BASE).post('/BTC/api/balances').reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
            await hooked.getBalancesBatch(['a1']);
            expect(onRetry.calledOnce).to.be.true;
            expect(onRetry.firstCall.args[0]).to.include({ service: 'explorer', method: 'POST', status: 503 });
        });

        it('a hook never fires for a refused list, because no request is attempted', async function () {
            const onRequest = sinon.spy();
            const hooked = new ExplorerClient(Object.assign({}, OPTS, { hooks: { onRequest } }));
            try { await hooked.getBalancesBatch([]); } catch (e) { /* expected */ }
            expect(onRequest.called).to.equal(false);
        });
    });


    describe('facade delegation', function () {

        let sdk;

        beforeEach(function () {
            sdk = new XChainSDK({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                noHub: true,
                retry: false
            });
        });

        it('sdk.getBalancesBatch reaches the batch route through the explorer client', async function () {
            const scope = nock(BASE).post('/BTC/api/balances', { addresses: ['a1', 'a2'] })
                .reply(200, { a1: { balances: { total: 7, data: [] }, address: null, error: null }, a2: {} });
            const result = await sdk.getBalancesBatch(['a1', 'a2']);
            expect(scope.isDone()).to.equal(true);
            expect(result.a1.balances.total).to.equal(7);
        });

        it('sdk.getCoinpayObligationsBatch reaches the batch route and forwards opts', async function () {
            const scope = nock(BASE).post('/BTC/api/coinpay_obligations', { addresses: ['a1'] })
                .query({ limit: '5' })
                .reply(200, { a1: { coinpay_obligations: { total: 0, data: [] }, error: null } });
            const result = await sdk.getCoinpayObligationsBatch(['a1'], { limit: 5 });
            expect(scope.isDone()).to.equal(true);
            expect(result.a1.coinpay_obligations.total).to.equal(0);
        });

        it('the facade refuses a bad list with the same error, before any request', async function () {
            const scope = nock(BASE).post('/BTC/api/balances').reply(200, { a0: { balances: null, address: null, error: null }, a1: { balances: null, address: null, error: null } });
            let thrown;
            try { await sdk.getBalancesBatch([]); } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKExplorerError);
            expect(thrown.code).to.equal('INVALID_ADDRESSES');
            expect(scope.isDone()).to.equal(false);
        });

        it('both methods are feature-detectable on the facade and on the client', function () {
            expect(typeof sdk.getBalancesBatch).to.equal('function');
            expect(typeof sdk.getCoinpayObligationsBatch).to.equal('function');
            expect(typeof client.getBalancesBatch).to.equal('function');
            expect(typeof client.getCoinpayObligationsBatch).to.equal('function');
        });
    });


    describe('typings', function () {

        it('index.d.ts declares both batch methods on the facade', function () {
            const dts = require('fs').readFileSync(require('path').join(__dirname, '../../index.d.ts'), 'utf8');
            expect(dts).to.match(/getBalancesBatch\(addresses: string\[\], opts\?: QueryOptions\): Promise<Record<string, any>>;/);
            expect(dts).to.match(/getCoinpayObligationsBatch\(addresses: string\[\], opts\?: QueryOptions\): Promise<Record<string, any>>;/);
        });
    });
});
