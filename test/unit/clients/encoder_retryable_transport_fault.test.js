// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

const BASE = 'http://encoder.test:3000';
const FAST_RETRY = { maxRetries: 2, baseDelay: 1, maxDelay: 2 };

function createClient(retry, hooks) {
    return new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000, retry, hooks });
}

function replyError(code, message) {
    return [200, { jsonrpc: '2.0', error: { code, message }, id: 1 }];
}

describe('EncoderClient retryable -32603 body error', function () {
    afterEach(function () {
        nock.cleanAll();
    });

    it('retries a -32603 body error and returns the later result', async function () {
        nock(BASE).post('/').reply(...replyError(-32603, 'node unavailable'));
        nock(BASE).post('/').reply(200, { jsonrpc: '2.0', result: 'pong', id: 2 });

        expect(await createClient(FAST_RETRY).ping()).to.equal('pong');
        expect(nock.isDone()).to.equal(true);
    });

    it('reports each retry through the onRetry hook', async function () {
        const seen = [];
        nock(BASE).post('/').reply(...replyError(-32603, 'node unavailable'));
        nock(BASE).post('/').reply(200, { jsonrpc: '2.0', result: 'pong', id: 2 });

        await createClient(FAST_RETRY, { onRetry: (info) => seen.push(info) }).ping();
        expect(seen).to.have.length(1);
        expect(seen[0].method).to.equal('ping');
    });

    it('surfaces ENCODER_RPC_ERROR marked retryable once retries are spent', async function () {
        nock(BASE).post('/').times(3).reply(...replyError(-32603, 'node unavailable'));

        let caught;
        try { await createClient(FAST_RETRY).ping(); } catch (e) { caught = e; }
        expect(caught.name).to.equal('SDKEncoderError');
        expect(caught.code).to.equal('ENCODER_RPC_ERROR');
        expect(caught.details.retryable).to.equal(true);
        expect(caught.details.rpcError.code).to.equal(-32603);
        expect(nock.isDone()).to.equal(true);
    });

    it('marks the error retryable without retrying when retry is disabled', async function () {
        nock(BASE).post('/').reply(...replyError(-32603, 'node unavailable'));

        let caught;
        try { await createClient(false).ping(); } catch (e) { caught = e; }
        expect(caught.code).to.equal('ENCODER_RPC_ERROR');
        expect(caught.details.retryable).to.equal(true);
    });

    it('does not retry a -32602 body error and marks it not retryable', async function () {
        nock(BASE).post('/').reply(...replyError(-32602, 'bad params'));

        let caught;
        try { await createClient(FAST_RETRY).ping(); } catch (e) { caught = e; }
        expect(caught.code).to.equal('ENCODER_RPC_ERROR');
        expect(caught.details.retryable).to.equal(false);
        expect(nock.isDone()).to.equal(true);
    });
});
