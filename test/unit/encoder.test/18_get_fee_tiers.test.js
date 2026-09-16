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

    describe('getFeeTiers', function () {
        it('calls estimate_fee RPC and returns low/medium/high tiers', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.jsonrpc).to.equal('2.0');
                    expect(body.method).to.equal('estimate_fee');
                    return true;
                })
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { low: 2, medium: 5, high: 12 },
                    id: 1
                });

            let result = await client.getFeeTiers();
            expect(result.low).to.equal(2);
            expect(result.medium).to.equal(5);
            expect(result.high).to.equal(12);
        });
    });
});
