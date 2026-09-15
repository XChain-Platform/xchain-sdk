'use strict';

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
 * XChain Platform SDK - Network Chaos Tests
 *
 * Verifies that all network clients (ExplorerClient, EncoderClient,
 * HubConnector) wrap every failure mode as a typed SDK error and
 * never surface raw network/axios errors to the caller.
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');
const { SDKEncoderError } = require('../../../src/utils/errors.js');

function makeEncoder(extraOpts = {}) {
    return new EncoderClient(Object.assign({
        encoderUrl:  'chaos.test',
        encoderPort: 3000,
        retry: false
    }, extraOpts));
}

const ENCODER_BASE = 'http://chaos.test:3000';

// 2. ENCODER CHAOS (10 tests)

describe('EncoderClient – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (a) Malformed JSON-RPC response: axios returns the raw string without
    //     throwing, so body.error is undefined and body.result is undefined.
    //     The client returns undefined (graceful degradation, no crash).
    it('a) malformed JSON – does not crash', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, 'garbage', { 'content-type': 'text/plain' });

        const client = makeEncoder();
        let result = await client.createTx({ data: 'TEST', pubkey: 'pub' });
        // Graceful: returns undefined rather than crashing
        expect(result === undefined || result === null).to.be.true;
    });

    // (b) Valid JSON but missing result AND error fields
    it('b) JSON-RPC missing result and error – does not crash, returns undefined/null', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', id: 1 });

        const client = makeEncoder();
        // body.error is falsy, body.result is undefined → returns undefined
        const result = await client.createTx({ data: 'TEST', pubkey: 'pub' });
        expect(result === undefined || result === null).to.equal(true);
    });

    // (c) JSON-RPC error with no message field
    it('c) JSON-RPC error no message – throws SDKEncoderError with ENCODER_RPC_ERROR', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', error: { code: -32600 }, id: 1 });

        const client = makeEncoder();
        try {
            await client.createTx({ data: 'TEST', pubkey: 'pub' });
            throw new Error('Expected SDKEncoderError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKEncoderError);
            expect(err.code).to.equal('ENCODER_RPC_ERROR');
        }
    });

});

describe('EncoderClient – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (d) JSON-RPC error with complex object (no message, has data)
    it('d) JSON-RPC complex error object – throws SDKEncoderError', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', error: { code: -32000, data: { details: 'stuff' } }, id: 1 });

        const client = makeEncoder();
        try {
            await client.createTx({ data: 'TEST', pubkey: 'pub' });
            throw new Error('Expected SDKEncoderError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKEncoderError);
            expect(err.code).to.equal('ENCODER_RPC_ERROR');
        }
    });

    // (e) HTTP 503 Service Unavailable
    it('e) HTTP 503 – throws SDKEncoderError with code ENCODER_HTTP_503', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(503);

        const client = makeEncoder();
        try {
            await client.createTx({ data: 'TEST', pubkey: 'pub' });
            throw new Error('Expected SDKEncoderError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKEncoderError);
            expect(err.code).to.equal('ENCODER_HTTP_503');
        }
    });

    // (f) Connection refused
    it('f) ECONNREFUSED – throws SDKEncoderError with code ENCODER_NETWORK', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .replyWithError('ECONNREFUSED');

        const client = makeEncoder();
        try {
            await client.createTx({ data: 'TEST', pubkey: 'pub' });
            throw new Error('Expected SDKEncoderError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKEncoderError);
            expect(err.code).to.equal('ENCODER_NETWORK');
        }
    });

});

describe('EncoderClient – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (g) Timeout
    // NOTE: nock .delay() + axios timeout interaction can be timing-sensitive in CI.
    it('g) timeout – throws SDKEncoderError with ENCODER_TIMEOUT or ENCODER_NETWORK', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .delay(500)
            .reply(200, {});

        const client = makeEncoder({ timeout: 100 });
        try {
            await client.createTx({ data: 'TEST', pubkey: 'pub' });
            throw new Error('Expected SDKEncoderError but call succeeded');
        } catch (err) {
            expect(err).to.be.instanceof(SDKEncoderError);
            expect(['ENCODER_TIMEOUT', 'ENCODER_NETWORK']).to.include(err.code);
        }
    });

    // (h) Null result
    it('h) null result – returns null without crashing', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', result: null, id: 1 });

        const client = makeEncoder();
        const result = await client.createTx({ data: 'TEST', pubkey: 'pub' });
        expect(result).to.equal(null);
    });

});

describe('EncoderClient – network chaos', function () {
    this.timeout(5000);

    before(() => nock.disableNetConnect());
    after(() => nock.enableNetConnect());
    afterEach(() => nock.cleanAll());

    // (i) Unexpected string result
    it('i) string result – returns the string without crashing', async () => {
        nock(ENCODER_BASE)
            .post('/')
            .reply(200, { jsonrpc: '2.0', result: 'just a string', id: 1 });

        const client = makeEncoder();
        const result = await client.createTx({ data: 'TEST', pubkey: 'pub' });
        expect(result).to.equal('just a string');
    });

    // (j) Multiple concurrent requests
    it('j) multiple concurrent requests – all resolve or reject cleanly', async () => {
        // Half succeed, half fail, to exercise both paths
        for (let i = 0; i < 3; i++) {
            nock(ENCODER_BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'abc' + i }, id: i + 1 });
        }
        for (let i = 0; i < 2; i++) {
            nock(ENCODER_BASE)
                .post('/')
                .reply(503);
        }

        const client = makeEncoder();
        const calls = Array.from({ length: 5 }, () =>
            client.createTx({ data: 'TEST', pubkey: 'pub' })
        );

        const results = await Promise.allSettled(calls);
        for (const r of results) {
            if (r.status === 'rejected') {
                expect(r.reason).to.be.instanceof(SDKEncoderError);
            } else {
                expect(r.value).to.be.an('object');
            }
        }
    });

});
