// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

const BASE = 'http://encoder.test:3000';

function createClient() {
    return new EncoderClient({
        encoderUrl: 'encoder.test',
        encoderPort: 3000,
        retry: false
    });
}

function mockRpc(method, params, result) {
    nock(BASE)
        .post('/', { jsonrpc: '2.0', method, params, id: 1 })
        .reply(200, { jsonrpc: '2.0', result, id: 1 });
}

describe('EncoderClient reservation release', function () {
    let client;

    beforeEach(function () {
        client = createClient();
    });

    afterEach(function () {
        nock.cleanAll();
    });

    it('sends release_inputs with the reservation ID and returns its result', async function () {
        const reservationId = '0123456789abcdef0123456789abcdef';
        const expected = {
            found: true,
            released: ['a'.repeat(64) + ':2']
        };

        mockRpc('release_inputs', { reservationId }, expected);

        expect(await client.releaseInputs(reservationId)).to.deep.equal(expected);
    });

    it('returns the encoder result for an unknown or expired reservation', async function () {
        const reservationId = '0'.repeat(32);
        const expected = { found: false, released: [] };

        mockRpc('release_inputs', { reservationId }, expected);

        expect(await client.releaseInputs(reservationId)).to.deep.equal(expected);
    });

    it('keeps the createTx reservation ID exactly as returned by the encoder', async function () {
        const reservationId = '0000000000000000000000000000000a';
        const expected = {
            psbt: 'feed',
            encoding: 'OP_RETURN',
            reservation: {
                id: reservationId,
                outpoints: ['b'.repeat(64) + ':1'],
                expiresAt: 1893456000000
            }
        };

        mockRpc('create_tx', { pubkey: 'pubkey', data: 'TEST' }, expected);

        const result = await client.createTx({ data: 'TEST', pubkey: 'pubkey' });

        expect(result).to.deep.equal(expected);
        expect(result.reservation.id).to.equal(reservationId);
    });
});
