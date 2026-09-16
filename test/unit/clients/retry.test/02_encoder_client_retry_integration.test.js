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
const EncoderClient = require('../../../../src/clients/encoder.js');


// Encoder retry integration tests

function registerEncoderResponseTests(getClient, encoderBase) {
    it('HTTP 502 then success: succeeds', async () => {
        nock(encoderBase)
            .post('/').reply(502)
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await getClient().ping();
        expect(result).to.equal('pong');
    });

    it('HTTP 500: throws immediately (500 is not retryable)', async () => {
        // Only register a single reply; a retry would exhaust nock and the test would
        // fail with a different error, making the assertion below reliable.
        nock(encoderBase)
            .post('/').reply(500, { error: 'internal server error' });

        let thrown;
        try {
            await getClient().ping();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.exist;
        expect(thrown.name).to.equal('SDKEncoderError');
        expect(thrown.code).to.equal('ENCODER_HTTP_500');
    });
}

function registerEncoderErrorTests(getClient, encoderBase) {
    it('JSON-RPC body.error: throws immediately (valid response, not retryable)', async () => {
        let rpcError = { code: -32601, message: 'Method not found' };
        nock(encoderBase)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, error: rpcError });

        let thrown;
        try {
            await getClient().ping();
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
        nock(encoderBase)
            .post('/').replyWithError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        let result = await getClient().ping();
        expect(result).to.equal('pong');
    });
}

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

    registerEncoderResponseTests(() => client, ENCODER_BASE);
    registerEncoderErrorTests(() => client, ENCODER_BASE);

});
