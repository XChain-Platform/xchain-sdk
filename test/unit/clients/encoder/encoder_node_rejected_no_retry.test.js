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

function rejectOnce(method, message) {
    return nock(BASE)
        .post('/', (body) => body.method === method)
        .reply(200, { jsonrpc: '2.0', error: { code: -32603, message }, id: 1 });
}

function allowUnexpectedSuccess(method, result) {
    return nock(BASE)
        .post('/', (body) => body.method === method)
        .reply(200, { jsonrpc: '2.0', result, id: 2 });
}

async function capture(promise) {
    try { await promise; } catch (error) { return error; }
    throw new Error('expected call to reject');
}

describe('EncoderClient node rejection retry boundary', function () {
    afterEach(function () {
        nock.cleanAll();
    });

    it('does not retry a deterministic broadcast_tx node rejection', async function () {
        const rejected = rejectOnce('broadcast_tx', 'bad-txns-inputs-missingorspent');
        const retry = allowUnexpectedSuccess('broadcast_tx', { txid: 'a'.repeat(64) });

        const caught = await capture(createClient().broadcastTx('00'));

        expect(caught.code).to.equal('ENCODER_RPC_ERROR');
        expect(caught.details).to.include({ method: 'broadcast_tx', retryable: false });
        expect(rejected.isDone()).to.equal(true);
        expect(retry.isDone()).to.equal(false);
    });

    it('does not retry a deterministic get_utxos tracker rejection', async function () {
        const rejected = rejectOnce('get_utxos', 'Invalid address');
        const retry = allowUnexpectedSuccess('get_utxos', { utxos: [] });

        const caught = await capture(createClient().getUTXOs('bad-address'));

        expect(caught.code).to.equal('ENCODER_RPC_ERROR');
        expect(caught.details).to.include({ method: 'get_utxos', retryable: false });
        expect(rejected.isDone()).to.equal(true);
        expect(retry.isDone()).to.equal(false);
    });

    it('does not report a JSON-RPC rejection through the retry hook', async function () {
        const seen = [];
        rejectOnce('get_utxos', 'Invalid address');

        await capture(createClient({ onRetry: (info) => seen.push(info) }).getUTXOs('bad-address'));

        expect(seen).to.deep.equal([]);
    });

    it('does not retry an ambiguous broadcast_tx connection reset', async function () {
        const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        const failed = nock(BASE).post('/', (body) => body.method === 'broadcast_tx').replyWithError(reset);
        const retry = allowUnexpectedSuccess('broadcast_tx', { txid: 'a'.repeat(64) });

        const caught = await capture(createClient().broadcastTx('00'));

        expect(caught.code).to.equal('ENCODER_NETWORK');
        expect(failed.isDone()).to.equal(true);
        expect(retry.isDone()).to.equal(false);
    });
});
