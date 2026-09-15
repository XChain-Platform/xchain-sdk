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

    describe('spendP2sh optional params', function () {
        it('passes encoding, rawData, compressedPubKey, change, fee, feePerKb, rbf, dust, unconfirmed', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.encoding).to.equal('P2WSH');
                    expect(body.params.rawData).to.equal('rawbytes');
                    expect(body.params.compressedPubKey).to.equal('02abc');
                    expect(body.params.change).to.equal('chaddr');
                    expect(body.params.fee).to.equal(500);
                    expect(body.params.feePerKb).to.equal(20000);
                    expect(body.params.rbf).to.equal(true);
                    expect(body.params.dust).to.equal(300);
                    expect(body.params.unconfirmed).to.equal(false);
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2WSH' }, id: 1 });

            let result = await client.spendP2sh({
                pubkey: 'pub',
                p2shHash: 'hash',
                p2shHex: 'rawhex',
                data: 'ACTION',
                encoding: 'p2wsh',
                rawData: 'rawbytes',
                compressedPubKey: '02abc',
                change: 'chaddr',
                fee: 500,
                feePerKb: 20000,
                rbf: true,
                dust: 300,
                unconfirmed: false
            });
            expect(result.psbt).to.equal('hex');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('spendP2sh optional params', function () {
        it('passes explicit data when provided', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.data).to.equal('MYACTION');
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            await client.spendP2sh({ pubkey: 'pub', p2shHash: 'h', p2shHex: 'x', data: 'MYACTION' });
        });

        // The native-fee protocol-fee output rides customOutputs and must
        // reach create_tx on the reveal (phase 2); an earlier spendP2sh dropped it.
        it('maps customOutputs into the create_tx params', async function () {
            const feeOutputs = [{ address: 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4', value: 10678 }];
            nock(BASE)
                .post('/', (body) => {
                    expect(body.params.customOutputs).to.deep.equal(feeOutputs);
                    return true;
                })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });

            await client.spendP2sh({
                pubkey: 'pub', p2shHash: 'h', p2shHex: 'x', data: 'ACTION',
                customOutputs: feeOutputs
            });
        });
    });
});
