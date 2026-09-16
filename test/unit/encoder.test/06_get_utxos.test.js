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

    describe('getUTXOs', function () {
        it('sends get_utxos RPC with address', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('get_utxos');
                    expect(body.params.address).to.equal('addr1');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { utxos: [{ txid: 'tx1', vout: 0, value: 10000 }] }, id: 1 });

            let result = await client.getUTXOs('addr1');
            expect(result.utxos).to.have.length(1);
            expect(result.utxos[0].txid).to.equal('tx1');
        });

        it('throws on missing address', async function () {
            try {
                await client.getUTXOs('');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKEncoderError');
                expect(e.code).to.equal('MISSING_ADDRESS');
            }
        });

        it('throws on null address', async function () {
            try {
                await client.getUTXOs(null);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_ADDRESS');
            }
        });
    });
});
