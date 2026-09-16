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

    describe('spendP2sh', function () {
        it('sends correct payload with empty data', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.method).to.equal('create_tx');
                    expect(body.params.data).to.equal('');
                    expect(body.params.pubkey).to.equal('pub');
                    expect(body.params.p2shHash).to.equal('hash123');
                    expect(body.params.p2shHex).to.equal('rawhex');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            let result = await client.spendP2sh({ pubkey: 'pub', p2shHash: 'hash123', p2shHex: 'rawhex' });
            expect(result.psbt).to.equal('hex');
        });

        it('throws on missing pubkey', async function () {
            try {
                await client.spendP2sh({ p2shHash: 'h', p2shHex: 'x' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_PUBKEY');
            }
        });

        it('throws on missing p2shHash', async function () {
            try {
                await client.spendP2sh({ pubkey: 'pub', p2shHex: 'x' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_P2SH_HASH');
            }
        });

        it('throws on missing p2shHex', async function () {
            try {
                await client.spendP2sh({ pubkey: 'pub', p2shHash: 'h' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('MISSING_P2SH_HEX');
            }
        });
    });
});
