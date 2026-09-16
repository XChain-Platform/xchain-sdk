// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('broadcastTx', function () {
        it('sends broadcast_tx RPC with tx_hex', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('broadcast_tx');
                    expect(body.params.tx_hex).to.equal('deadbeef');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { txid: 'abc123' }, id: 1 });

            let result = await client.broadcastTx('deadbeef');
            expect(result.txid).to.equal('abc123');
        });

        it('throws on missing txHex', async function () {
            try {
                await client.broadcastTx('');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('MISSING_TX_HEX');
            }
        });

        it('throws on null txHex', async function () {
            try {
                await client.broadcastTx(null);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_TX_HEX');
            }
        });
    });
});
