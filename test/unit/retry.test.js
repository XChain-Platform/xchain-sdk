/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Retry Logic & Request Hooks Tests
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../src/explorer.js');
const EncoderClient  = require('../../src/encoder.js');
const { withRetry, isRetryable, getDelay, DEFAULTS } = require('../../src/retry.js');


// Section 1: Retry utility unit tests

describe('retry utility', () => {

    // isRetryable

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


    // getDelay

    describe('getDelay()', () => {

        it('returns a number > 0 for attempt 0', () => {
            let config = { baseDelay: 100, maxDelay: 30000, backoffFactor: 2 };
            let delay = getDelay(0, config);
            expect(delay).to.be.a('number').and.to.be.at.least(0);
            // With 25% jitter the minimum possible is 100 * 1 * 0.75 = 75, but
            // Math.max(0,...) is used so just verify it is non-negative and > 0 on average.
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


    // withRetry

    describe('withRetry()', () => {

        it('succeeds on first try: fn called exactly once', async () => {
            let callCount = 0;
            let result = await withRetry(async () => {
                callCount++;
                return 'ok';
            }, { maxRetries: 2, baseDelay: 10 });
            expect(result).to.equal('ok');
            expect(callCount).to.equal(1);
        });

        it('fails once then succeeds: fn called exactly twice', async () => {
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

        it('fails with non-retryable error: throws immediately, fn called once', async () => {
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

        it('exhausts all retries: throws last error', async () => {
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


// Section 2: Explorer retry integration tests

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

    it('HTTP 503 then 200: succeeds', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(503)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await client.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

    it('HTTP 429 then 200: succeeds', async () => {
        nock(EXPLORER_BASE)
            .get('/BTC/api/status').reply(429)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await client.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });

    it('HTTP 503 three times: throws SDKExplorerError (maxRetries: 2 = 3 total attempts)', async () => {
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

    it('HTTP 400: throws immediately, no retry', async () => {
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

    it('retry: false, HTTP 503 throws immediately without retry', async () => {
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


// Section 3: Encoder retry integration tests

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

    it('HTTP 502 then success: succeeds', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(502)
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await client.ping();
        expect(result).to.equal('pong');
    });

    it('HTTP 500: throws immediately (500 is not retryable)', async () => {
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

    it('JSON-RPC body.error: throws immediately (valid response, not retryable)', async () => {
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

    it('network error (ECONNRESET) then success: succeeds', async () => {
        // Pass a real Error instance carrying the code so the network error
        // propagates to the HTTP client as a socket error (object literals are
        // not surfaced as connection errors by the interceptor)
        nock(ENCODER_BASE)
            .post('/').replyWithError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await client.ping();
        expect(result).to.equal('pong');
    });

});


// Section 4: Request hook tests

describe('request hooks - ExplorerClient', () => {

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

    it('no hooks configured: no crash on successful request', async () => {
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


describe('request hooks - EncoderClient', () => {

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

    it('no hooks configured: no crash on successful request', async () => {
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

// Pure retry helpers (parseRetryAfter / getRetryAfterDelay / getDelay) ──
// getDelay / DEFAULTS are already imported at the top of this file; only pull in
// the helpers not already bound here.
const { parseRetryAfter, getRetryAfterDelay } = require('../../src/retry.js');

describe('retry helpers (pure)', function () {

    describe('parseRetryAfter', function () {
        it('returns null for falsy input', function () {
            expect(parseRetryAfter(null)).to.equal(null);
            expect(parseRetryAfter('')).to.equal(null);
            expect(parseRetryAfter(undefined)).to.equal(null);
        });

        it('parses integer seconds to milliseconds', function () {
            expect(parseRetryAfter('120')).to.equal(120000);
            expect(parseRetryAfter('0')).to.equal(0);
        });

        it('parses an HTTP-date to a non-negative delay', function () {
            const ms = parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT');
            expect(ms).to.be.a('number');
            expect(ms).to.be.greaterThan(0);
        });

        it('clamps a past HTTP-date to 0', function () {
            const ms = parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT');
            expect(ms).to.equal(0);
        });

        it('returns null for an unparseable value', function () {
            expect(parseRetryAfter('not-a-date-or-number')).to.equal(null);
        });
    });

    describe('getRetryAfterDelay', function () {
        it('returns null when the error has no response/headers', function () {
            expect(getRetryAfterDelay(null)).to.equal(null);
            expect(getRetryAfterDelay({})).to.equal(null);
            expect(getRetryAfterDelay({ response: {} })).to.equal(null);
        });

        it('extracts the Retry-After header from an axios-style error', function () {
            const err = { response: { headers: { 'retry-after': '30' } } };
            expect(getRetryAfterDelay(err)).to.equal(30000);
        });
    });

    describe('getDelay', function () {
        it('honours a Retry-After header, capped at maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 5000 };
            const err = { response: { headers: { 'retry-after': '30' } } }; // 30000 > cap
            expect(getDelay(0, cfg, err)).to.equal(5000);
        });

        it('falls back to exponential backoff (+/- jitter) without a Retry-After', function () {
            const cfg = { baseDelay: 100, backoffFactor: 2, maxDelay: 100000 };
            // attempt 3 → base*2^3 = 800, ±25% jitter → within [600, 1000]
            const d = getDelay(3, cfg, new Error('net'));
            expect(d).to.be.greaterThan(599);
            expect(d).to.be.lessThan(1001);
        });

        it('caps exponential backoff at maxDelay (jitter is applied after the cap)', function () {
            const cfg = { baseDelay: 1000, backoffFactor: 10, maxDelay: 2000 };
            const d = getDelay(5, cfg, new Error('net')); // huge → capped to 2000, then ±25% jitter
            // The cap is applied BEFORE the ±25% jitter, so the final value lands in
            // [maxDelay*0.75, maxDelay*1.25] = [1500, 2500], never the un-capped huge value.
            expect(d).to.be.at.least(1500);
            expect(d).to.be.at.most(2500);
        });
    });
});


// Section 5: the 429 path (rate limits)
//
// A rate limit is a policy answer with a wait attached, so it is budgeted and
// capped apart from 5xx backoff: retryAfterMaxDelay caps the honoured wait
// (maxDelay does not), maxRateLimitRetries caps how many 429s are retried, and
// a 429 that survives the retry reaches the caller as SDKRateLimitedError.

const { getRetryAfterSeconds, getRateLimitDelay, parseRateLimitReset } = require('../../src/retry.js');
const { SDKError, SDKExplorerError, SDKEncoderError, SDKRateLimitedError } = require('../../src/errors.js');

function rateLimitErr(headers, status = 429) {
    return { response: { status, headers, data: { error: 'rate limited' } } };
}

describe('retry: the 429 path', function () {

    describe('DEFAULTS', function () {
        it('caps an honoured Retry-After at 60 s and retries a 429 once', function () {
            expect(DEFAULTS.retryAfterMaxDelay).to.equal(60000);
            expect(DEFAULTS.maxRateLimitRetries).to.equal(1);
        });
    });

    describe('getDelay() on a 429', function () {

        it('(a) honours Retry-After: 30 past a maxDelay of 2000', function () {
            // The wallet ships maxDelay: 2000 to keep 5xx backoff short. That
            // must not shrink the wait a rate limiter actually asked for.
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }))).to.equal(30000);
        });

        it('(b) a 503 with Retry-After: 30 still clamps to maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }, 503))).to.equal(2000);
        });

        it('caps an absurd Retry-After at retryAfterMaxDelay, not maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000, retryAfterMaxDelay: 60000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '900' }))).to.equal(60000);
        });

        it('honours an overridden retryAfterMaxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000, retryAfterMaxDelay: 5000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }))).to.equal(5000);
        });

        it('(c) falls back to RateLimit-Reset when Retry-After is absent', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'ratelimit-reset': '45' }))).to.equal(45000);
        });

        it('prefers Retry-After over RateLimit-Reset when both are present', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '10', 'ratelimit-reset': '45' }))).to.equal(10000);
        });

        it('falls back to normal backoff for a 429 carrying neither header', function () {
            const cfg = { baseDelay: 100, backoffFactor: 2, maxDelay: 2000, retryAfterMaxDelay: 60000 };
            const d = getDelay(3, cfg, rateLimitErr({}));
            // base*2^3 = 800, ±25% jitter, and nowhere near the 60 s ceiling
            expect(d).to.be.greaterThan(599);
            expect(d).to.be.lessThan(1001);
        });

    });

    describe('parseRateLimitReset() / getRateLimitDelay() / getRetryAfterSeconds()', function () {

        it('parseRateLimitReset turns whole seconds into milliseconds', function () {
            expect(parseRateLimitReset('45')).to.equal(45000);
            expect(parseRateLimitReset('0')).to.equal(0);
        });

        it('parseRateLimitReset returns null for absent or unparseable values', function () {
            expect(parseRateLimitReset(undefined)).to.equal(null);
            expect(parseRateLimitReset('')).to.equal(null);
            expect(parseRateLimitReset('soon')).to.equal(null);
            expect(parseRateLimitReset('-5')).to.equal(null);
        });

        it('getRateLimitDelay returns null when neither header is present', function () {
            expect(getRateLimitDelay(rateLimitErr({}))).to.equal(null);
            expect(getRateLimitDelay(null)).to.equal(null);
        });

        it('getRetryAfterSeconds reads whole seconds off either header', function () {
            expect(getRetryAfterSeconds(rateLimitErr({ 'retry-after': '30' }))).to.equal(30);
            expect(getRetryAfterSeconds(rateLimitErr({ 'ratelimit-reset': '45' }))).to.equal(45);
        });

        it('getRetryAfterSeconds rounds UP, since waiting short buys another 429', function () {
            // An origin's HTTP-date lands on a whole second, our clock does not,
            // so the delta is fractional. Freeze the clock 1.4 s short of the
            // date: rounding DOWN would send the retry back before the window
            // reopened. Frozen rather than sampled, or the sub-second phase of
            // the real clock decides whether this test passes.
            const realNow = Date.now;
            const when    = 'Fri, 01 Jan 2100 00:00:02 GMT';
            Date.now = () => Date.parse(when) - 1400;
            try {
                expect(getRetryAfterSeconds(rateLimitErr({ 'retry-after': when }))).to.equal(2);
            } finally {
                Date.now = realNow;
            }
        });

        it('getRetryAfterSeconds returns null when the response asked for nothing', function () {
            expect(getRetryAfterSeconds(rateLimitErr({}))).to.equal(null);
        });

    });

    describe('withRetry() 429 budget', function () {

        it('(d) maxRateLimitRetries: 1 with maxRetries: 3 throws on the second 429', async function () {
            let callCount = 0;
            const err429 = { response: { status: 429, headers: {} }, message: 'too many requests' };

            let thrown;
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err429;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 1 });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.equal(err429);
            // One honoured retry, then the caller gets the rate limit, even
            // though maxRetries would have allowed three attempts more.
            expect(callCount).to.equal(2);
        });

        it('maxRateLimitRetries: 0 throws the first 429 without retrying', async function () {
            let callCount = 0;
            const err429 = { response: { status: 429, headers: {} }, message: 'too many requests' };
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err429;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 0 });
            } catch (e) { /* expected */ }
            expect(callCount).to.equal(1);
        });

        it('the 429 budget does not shrink the 5xx budget', async function () {
            let callCount = 0;
            const err503 = { response: { status: 503, headers: {} }, message: 'unavailable' };
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err503;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 1 });
            } catch (e) { /* expected */ }
            expect(callCount).to.equal(4);
        });

    });

    describe('(e) ExplorerClient on a surviving 429', function () {

        const EXPLORER_BASE = 'http://ratelimit.test:8080';

        function makeClient() {
            // retryAfterMaxDelay: 20 keeps the honoured wait at 20 ms in-test
            // while the header still says 30 s, so the reported seconds and the
            // cap are exercised independently.
            return new ExplorerClient({
                network:      'bitcoin-mainnet',
                explorerUrl:  'ratelimit.test',
                explorerPort: 8080,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 }
            });
        }

        afterEach(() => nock.cleanAll());

        it('429 then 200: the retry is honoured and the caller sees nothing', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(200, { ok: true });

            const result = await makeClient().getStatus();
            expect(result).to.deep.equal({ ok: true });
        });

        it('429 then 429: throws SDKRateLimitedError carrying the seconds', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' });

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }

            expect(thrown).to.exist;
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown).to.be.instanceof(SDKRateLimitedError);
            expect(thrown).to.be.instanceof(SDKError);
            expect(thrown.code).to.equal('RATE_LIMITED');
            expect(thrown.service).to.equal('explorer');
            expect(thrown.status).to.equal(429);
            expect(thrown.retryAfterSeconds).to.equal(30);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status; retry after 30 seconds');
            expect(thrown.details.url).to.equal('/BTC/api/status');
            expect(thrown.details.data).to.deep.equal({ error: 'slow down' });
        });

        it('429 with RateLimit-Reset only: the seconds come off the fallback header', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {}, { 'RateLimit-Reset': '45' })
                .get('/BTC/api/status').reply(429, {}, { 'RateLimit-Reset': '45' });

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown.retryAfterSeconds).to.equal(45);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status; retry after 45 seconds');
        });

        it('429 with no wait header: the message omits the suffix and the field is null', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {})
                .get('/BTC/api/status').reply(429, {});

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown.retryAfterSeconds).to.equal(null);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status');
        });

        it('a 503 is unaffected: still SDKExplorerError with the HTTP code', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(503)
                .get('/BTC/api/status').reply(503)
                .get('/BTC/api/status').reply(503);

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKExplorerError);
            expect(thrown.code).to.equal('EXPLORER_HTTP_503');
        });

        it('the onRetry hook payload carries the status', async function () {
            const seen = [];
            const client = new ExplorerClient({
                network:      'bitcoin-mainnet',
                explorerUrl:  'ratelimit.test',
                explorerPort: 8080,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 },
                hooks: { onRetry: (info) => seen.push(info) }
            });

            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {}, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(200, { ok: true });

            await client.getStatus();
            expect(seen).to.have.lengthOf(1);
            expect(seen[0].status).to.equal(429);
            expect(seen[0].service).to.equal('explorer');
        });

    });

    describe('(f) EncoderClient on a surviving 429', function () {

        const ENCODER_BASE = 'http://ratelimit.test:3000';

        function makeClient() {
            return new EncoderClient({
                encoderUrl:  'ratelimit.test',
                encoderPort: 3000,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 }
            });
        }

        afterEach(() => nock.cleanAll());

        it('429 then 200: the retry is honoured and the caller sees nothing', async function () {
            nock(ENCODER_BASE)
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

            expect(await makeClient().ping()).to.equal('pong');
        });

        it('429 then 429: throws SDKRateLimitedError carrying the seconds', async function () {
            nock(ENCODER_BASE)
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .post('/').reply(429, { error: 'slow down' }, { 'Retry-After': '30' });

            let thrown;
            try {
                await makeClient().ping();
            } catch (e) { thrown = e; }

            expect(thrown).to.exist;
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown.code).to.equal('RATE_LIMITED');
            expect(thrown.service).to.equal('encoder');
            expect(thrown.status).to.equal(429);
            expect(thrown.retryAfterSeconds).to.equal(30);
            expect(thrown.message).to.equal('Encoder returned HTTP 429 for method ping; retry after 30 seconds');
            expect(thrown.details.method).to.equal('ping');
        });

        it('a 500 is unaffected: still SDKEncoderError with the HTTP code', async function () {
            nock(ENCODER_BASE).post('/').reply(500, { error: 'internal' });

            let thrown;
            try {
                await makeClient().ping();
            } catch (e) { thrown = e; }
            expect(thrown).to.be.instanceof(SDKEncoderError);
            expect(thrown.code).to.equal('ENCODER_HTTP_500');
        });

        it('the onRetry hook payload carries the status', async function () {
            const seen = [];
            const client = new EncoderClient({
                encoderUrl:  'ratelimit.test',
                encoderPort: 3000,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 },
                hooks: { onRetry: (info) => seen.push(info) }
            });

            nock(ENCODER_BASE)
                .post('/').reply(429, {}, { 'Retry-After': '30' })
                .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

            await client.ping();
            expect(seen).to.have.lengthOf(1);
            expect(seen[0].status).to.equal(429);
            expect(seen[0].service).to.equal('encoder');
        });

    });

});
