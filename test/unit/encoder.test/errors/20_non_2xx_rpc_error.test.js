// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Pins that the encoder's JSON-RPC error survives a non-2xx status: the
// encoder answers 401 -32001, 429 -32029 and 400 -32600 with a normal error body.

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../../src/clients/encoder.js');

const BASE = 'http://encoder.test:3000';

// Return the error one call rejects with, after the encoder answers status and body.
async function rejectionOf(status, body, call) {
    let client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000, retry: false });
    nock(BASE).post('/').reply(status, body);
    try {
        await call(client);
    } catch (e) {
        return e;
    }
    expect.fail('should have thrown');
}

// Build a JSON-RPC error body the way the encoder sends one.
function rpcBody(code, message, data) {
    let error = data === undefined ? { code, message } : { code, message, data };
    return { jsonrpc: '2.0', id: 1, error };
}

const createTx = (client) => client.createTx({ data: 'TEST', pubkey: 'pub' });

describe('EncoderClient non-2xx JSON-RPC errors', function () {
    afterEach(function () {
        nock.cleanAll();
    });

    it('keeps the encoder JSON-RPC error from a 401 body', async function () {
        let e = await rejectionOf(401, rpcBody(-32001, 'Unauthorized'), createTx);
        expect(e.name).to.equal('SDKEncoderError');
        expect(e.code).to.equal('ENCODER_HTTP_401');
        expect(e.message).to.equal('Encoder returned HTTP 401 for method create_tx: Unauthorized (code -32001)');
        expect(e.details.rpcError).to.deep.equal({ code: -32001, message: 'Unauthorized' });
        expect(e.details.context).to.equal(null);
        expect(e.details.status).to.equal(401);
    });

    it('keeps the encoder JSON-RPC error from a 400 batch refusal', async function () {
        let e = await rejectionOf(400, rpcBody(-32600, 'Batch too large (max 20 requests per call)', { max: 20 }), createTx);
        expect(e.code).to.equal('ENCODER_HTTP_400');
        expect(e.message).to.match(/^Encoder returned HTTP 400 for method create_tx: Batch too large/);
        expect(e.details.rpcError.code).to.equal(-32600);
        expect(e.details.context).to.deep.equal({ max: 20 });
    });

    it('adds the encoder JSON-RPC error to a surviving 429 without changing its message', async function () {
        let e = await rejectionOf(429, rpcBody(-32029, 'Too many requests'), (client) => client.ping());
        expect(e.name).to.equal('SDKRateLimitedError');
        expect(e.message).to.equal('Encoder returned HTTP 429 for method ping');
        expect(e.details.rpcError.code).to.equal(-32029);
    });

    it('leaves a non-JSON-RPC 502 body out of the message and details', async function () {
        let e = await rejectionOf(502, '<html>Bad Gateway</html>', createTx);
        expect(e.code).to.equal('ENCODER_HTTP_502');
        expect(e.message).to.equal('Encoder returned HTTP 502 for method create_tx');
        expect(e.details).to.not.have.property('rpcError');
    });
});
