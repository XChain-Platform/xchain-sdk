// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../../src/clients/encoder.js');

const BASE = 'http://encoder.test:3000';
const FAST_RETRY = { maxRetries: 2, baseDelay: 1, maxDelay: 2 };

function createClient(hooks) {
    return new EncoderClient({
        encoderUrl: 'encoder.test',
        encoderPort: 3000,
        retry: FAST_RETRY,
        hooks
    });
}

function resetFault() {
    return Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
}

describe('EncoderClient retryable transport fault', function () {
    afterEach(function () {
        nock.cleanAll();
    });

    it('retries a connection reset for a read-only RPC and returns the later result', async function () {
        nock(BASE).post('/').replyWithError(resetFault());
        nock(BASE).post('/').reply(200, { jsonrpc: '2.0', result: 'pong', id: 2 });

        expect(await createClient().ping()).to.equal('pong');
        expect(nock.isDone()).to.equal(true);
    });

    it('retries an HTTP 503 for get_utxos and returns the later result', async function () {
        const expected = { utxos: [] };
        nock(BASE).post('/').reply(503, 'busy');
        nock(BASE).post('/').reply(200, { jsonrpc: '2.0', result: expected, id: 2 });

        expect(await createClient().getUTXOs('funding-address')).to.deep.equal(expected);
        expect(nock.isDone()).to.equal(true);
    });

    it('reports the real transport status through the onRetry hook', async function () {
        const seen = [];
        nock(BASE).post('/').reply(503, 'busy');
        nock(BASE).post('/').reply(200, { jsonrpc: '2.0', result: 'pong', id: 2 });

        await createClient({ onRetry: (info) => seen.push(info) }).ping();

        expect(seen).to.have.length(1);
        expect(seen[0]).to.include({ method: 'ping', status: 503, rpcCode: null });
    });

    it('surfaces ENCODER_NETWORK after connection-reset retries are spent', async function () {
        nock(BASE).post('/').times(3).replyWithError(resetFault());

        let caught;
        try { await createClient().ping(); } catch (error) { caught = error; }

        expect(caught.name).to.equal('SDKEncoderError');
        expect(caught.code).to.equal('ENCODER_NETWORK');
        expect(nock.isDone()).to.equal(true);
    });
});
