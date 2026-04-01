/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain SDK - Retry Logic & Request Hooks Tests
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../src/explorer.js');
const EncoderClient  = require('../src/encoder.js');
const { withRetry, isRetryable, getDelay, DEFAULTS } = require('../src/retry.js');


// ---------------------------------------------------------------------------
// Section 1: Retry utility unit tests
// ---------------------------------------------------------------------------

describe('retry utility', () => {

    // -----------------------------------------------------------------------
    // isRetryable
    // -----------------------------------------------------------------------

    describe('isRetryable()', () => {

        it('returns true for HTTP 429', () => {
            expect(isRetryable({ response: { status: 429 } })).to.equal(true);
        });

        it('returns true for HTTP 502', () => {
            expect(isRetryable({ response: { status: 502 } })).to.equal(true);
        });

        it('returns true for HTTP 503', () => {
            expect(isRetryable({ response: { status: 503 } })).to.equal(true);
        });

        it('returns true for HTTP 504', () => {
            expect(isRetryable({ response: { status: 504 } })).to.equal(true);
        });

        it('returns false for HTTP 400', () => {
            expect(isRetryable({ response: { status: 400 } })).to.equal(false);
        });

        it('returns false for HTTP 404', () => {
            expect(isRetryable({ response: { status: 404 } })).to.equal(false);
        });

        it('returns true for ECONNABORTED (timeout)', () => {
            expect(isRetryable({ code: 'ECONNABORTED' })).to.equal(true);
        });

        it('returns true for ECONNRESET', () => {
            expect(isRetryable({ code: 'ECONNRESET' })).to.equal(true);
        });

        it('returns false for error with no response and no code', () => {
            expect(isRetryable({})).to.equal(false);
        });

    });


    // -----------------------------------------------------------------------
    // getDelay
    // -----------------------------------------------------------------------

    describe('getDelay()', () => {

        it('returns a number > 0 for attempt 0', () => {
            let config = { baseDelay: 100, maxDelay: 30000, backoffFactor: 2 };
            let delay = getDelay(0, config);
            expect(delay).to.be.a('number').and.to.be.at.least(0);
            // With 25% jitter the minimum possible is 100 * 1 * 0.75 = 75, but
            // Math.max(0, ...) is used so just verify it is non-negative and > 0 on average.
            // Use a looser check: delay should be > 0 (statistically always true for baseDelay=100)
            expect(delay).to.be.greaterThan(0);
        });

        it('increases with attempt number (attempt 1 < attempt 3 on average)', () => {
            let config = { baseDelay: 100, maxDelay: 30000, backoffFactor: 2 };
            // Run several samples and compare medians to reduce jitter noise
            let sum1 = 0, sum3 = 0, samples = 20;
            for (let i = 0; i < samples; i++) {
                sum1 += getDelay(1, config);
                sum3 += getDelay(3, config);
            }
            expect(sum3 / samples).to.be.greaterThan(sum1 / samples);
        });

        it('never exceeds maxDelay + 25% jitter', () => {
            // getDelay clamps to maxDelay before adding ±25% jitter, so the
            // observable ceiling is maxDelay * 1.25. Verify we never exceed it.
            let config = { baseDelay: 1000, maxDelay: 5000, backoffFactor: 2 };
            let ceiling = config.maxDelay * 1.25;
            for (let attempt = 0; attempt < 20; attempt++) {
                expect(getDelay(attempt, config)).to.be.at.most(ceiling);
            }
        });

    });


    // -----------------------------------------------------------------------
    // withRetry
    // -----------------------------------------------------------------------

    describe('withRetry()', () => {

        it('succeeds on first try — fn called exactly once', async () => {
            let callCount = 0;
            let result = await withRetry(async () => {
                callCount++;
                return 'ok';
            }, { maxRetries: 2, baseDelay: 10 });
            expect(result).to.equal('ok');
            expect(callCount).to.equal(1);
        });

        it('fails once then succeeds — fn called exactly twice', async () => {
            let callCount = 0;
            let result = await withRetry(async () => {
                callCount++;
                if (callCount === 1) {
                    let err = new Error('transient');
                    err.response = { status: 503 };
                    throw err;
                }
                return 'recovered';
            }, { maxRetries: 2, baseDelay: 10 });
            expect(result).to.equal('recovered');
            expect(callCount).to.equal(2);
        });

        it('fails with non-retryable error — throws immediately, fn called once', async () => {
            let callCount = 0;
            let err400 = new Error('bad request');
            err400.response = { status: 400 };

            let thrown;
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err400;
                }, { maxRetries: 2, baseDelay: 10 });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.equal(err400);
            expect(callCount).to.equal(1);
        });

        it('exhausts all retries — throws last error', async () => {
            let callCount = 0;
            let transient = new Error('service unavailable');
            transient.response = { status: 503 };

            let thrown;
            try {
                await withRetry(async () => {
                    callCount++;
                    throw transient;
                }, { maxRetries: 2, baseDelay: 10 });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.equal(transient);
            // 1 initial + 2 retries = 3 total
            expect(callCount).to.equal(3);
        });

    });

});


// ---------------------------------------------------------------------------
// Section 2: Explorer retry integration tests
// ---------------------------------------------------------------------------

describe('ExplorerClient retry integration', () => {

    const EXPLORER_BASE = 'http://retry.test:8080';

    let client;

    beforeEach(() => {
        client = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'retry.test',
            explorerPort: 8080,
            retry: { maxRetries: 2, baseDelay: 50 }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('HTTP 503 then 200 — succeeds', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await client.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

    it('HTTP 429 then 200 — succeeds', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(429)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await client.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

    it('HTTP 503 three times — throws SDKExplorerError (maxRetries: 2 = 3 total attempts)', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(503);

        let thrown;
        try {
            await client.getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_503');
    });

    it('HTTP 400 — throws immediately, no retry', async () => {
        // Only one nock scope; a retry would cause nock to throw "Nock: No match" (test would fail differently)
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(400, { error: 'bad request' });

        let thrown;
        try {
            await client.getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_400');
    });

    it('retry: false — HTTP 503 throws immediately without retry', async () => {
        let noRetryClient = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'retry.test',
            explorerPort: 8080,
            retry: false
        });

        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(503);

        let thrown;
        try {
            await noRetryClient.getStatus();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKExplorerError');
        expect(thrown.code).to.equal('EXPLORER_HTTP_503');
    });

});


// ---------------------------------------------------------------------------
// Section 3: Encoder retry integration tests
// ---------------------------------------------------------------------------

describe('EncoderClient retry integration', () => {

    const ENCODER_BASE = 'http://retry.test:3000';

    let client;

    beforeEach(() => {
        client = new EncoderClient({
            encoderUrl:  'retry.test',
            encoderPort: 3000,
            retry: { maxRetries: 1, baseDelay: 50 }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('HTTP 502 then success — succeeds', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(502)
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await client.ping();
        expect(result).to.equal('pong');
    });

    it('HTTP 500 — throws immediately (500 is not retryable)', async () => {
        // Only register a single reply; a retry would exhaust nock and the test would
        // fail with a different error, making the assertion below reliable.
        nock(ENCODER_BASE)
            .post('/').reply(500, { error: 'internal server error' });

        let thrown;
        try {
            await client.ping();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKEncoderError');
        expect(thrown.code).to.equal('ENCODER_HTTP_500');
    });

    it('JSON-RPC body.error — throws immediately (valid response, not retryable)', async () => {
        let rpcError = { code: -32601, message: 'Method not found' };
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, error: rpcError });

        let thrown;
        try {
            await client.ping();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKEncoderError');
        expect(thrown.code).to.equal('ENCODER_RPC_ERROR');
    });

    it('network error (ECONNRESET) then success — succeeds', async () => {
        // Pass an object so nock preserves the error code (plain string sets only message)
        nock(ENCODER_BASE)
            .post('/').replyWithError({ code: 'ECONNRESET', message: 'connection reset' })
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await client.ping();
        expect(result).to.equal('pong');
    });

});


// ---------------------------------------------------------------------------
// Section 4: Request hook tests
// ---------------------------------------------------------------------------

describe('request hooks — ExplorerClient', () => {

    const EXPLORER_BASE = 'http://hooks.test:8080';

    let log;
    let client;

    beforeEach(() => {
        log = [];
        client = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'hooks.test',
            explorerPort: 8080,
            retry: false,
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info })
            }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('onRequest fires before each request', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(200, { ok: true });

        await client.getStatus();
        let req = log.find(e => e.type === 'request');
        expect(req).to.exist;
        expect(req.service).to.equal('explorer');
    });

    it('onResponse fires on success with status 200', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(200, { ok: true });

        await client.getStatus();
        let res = log.find(e => e.type === 'response');
        expect(res).to.exist;
        expect(res.status).to.equal(200);
    });

    it('onError fires on HTTP error', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(500, { error: 'server error' });

        try { await client.getStatus(); } catch (_) {}
        let errEntry = log.find(e => e.type === 'error');
        expect(errEntry).to.exist;
    });

    it('hook info includes service: explorer and method: GET', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(200, { ok: true });

        await client.getStatus();
        let req = log.find(e => e.type === 'request');
        expect(req.service).to.equal('explorer');
        expect(req.method).to.equal('GET');
    });

    it('no hooks configured — no crash on successful request', async () => {
        let noHookClient = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'hooks.test',
            explorerPort: 8080,
            retry: false
        });

        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await noHookClient.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

});


describe('request hooks — EncoderClient', () => {

    const ENCODER_BASE = 'http://hooks.test:3000';

    let log;
    let client;

    beforeEach(() => {
        log = [];
        client = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: false,
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info }),
                onRetry:    (info) => log.push({ type: 'retry',    ...info })
            }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('onRequest fires with service: encoder and the RPC method name', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        await client.ping();
        let req = log.find(e => e.type === 'request');
        expect(req).to.exist;
        expect(req.service).to.equal('encoder');
        expect(req.method).to.equal('ping');
    });

    it('onResponse fires on success', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        await client.ping();
        let res = log.find(e => e.type === 'response');
        expect(res).to.exist;
        expect(res.service).to.equal('encoder');
    });

    it('onError fires on RPC error', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });

        try { await client.ping(); } catch (_) {}
        let errEntry = log.find(e => e.type === 'error');
        expect(errEntry).to.exist;
        expect(errEntry.service).to.equal('encoder');
    });

    it('onRetry fires on retry', async () => {
        let retryClient = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: { maxRetries: 1, baseDelay: 10 },
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info }),
                onRetry:    (info) => log.push({ type: 'retry',    ...info })
            }
        });

        nock(ENCODER_BASE)
            .post('/').reply(503)
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        await retryClient.ping();
        let retryEntry = log.find(e => e.type === 'retry');
        expect(retryEntry).to.exist;
        expect(retryEntry.service).to.equal('encoder');
    });

    it('no hooks configured — no crash on successful request', async () => {
        let noHookClient = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: false
        });

        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        let result = await noHookClient.ping();
        expect(result).to.equal('pong');
    });

});
