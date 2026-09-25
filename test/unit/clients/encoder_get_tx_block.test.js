// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient getTxBlock', function () {
    const BASE = 'http://encoder.test:3000';
    const TXID = 'a'.repeat(64);
    let client;

    beforeEach(function () {
        client = new EncoderClient({
            encoderUrl: 'encoder.test',
            encoderPort: 3000,
            retry: false
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    it('sends get_tx_block with the txid and returns the result', async function () {
        const expected = {
            block_hash: 'b'.repeat(64),
            block_height: 123,
            sync: {
                committed_height: 125,
                committed_hash: 'c'.repeat(64)
            }
        };

        nock(BASE)
            .post('/', {
                jsonrpc: '2.0',
                method: 'get_tx_block',
                params: { txid: TXID },
                id: 1
            })
            .reply(200, { jsonrpc: '2.0', result: expected, id: 1 });

        expect(await client.getTxBlock(TXID)).to.deep.equal(expected);
    });

    it('returns null when the encoder reports no indexed block', async function () {
        nock(BASE)
            .post('/', (body) => body.method === 'get_tx_block'
                && body.params.txid === TXID)
            .reply(200, { jsonrpc: '2.0', result: null, id: 1 });

        expect(await client.getTxBlock(TXID)).to.equal(null);
    });
});
