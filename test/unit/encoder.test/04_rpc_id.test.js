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

    describe('RPC ID', function () {
        it('increments with each call', async function () {
            let ids = [];
            nock(BASE)
                .post('/', (body) => { ids.push(body.id); return true; })
                .reply(200, { jsonrpc: '2.0', result: { status: 'success' }, id: 1 })
                .post('/', (body) => { ids.push(body.id); return true; })
                .reply(200, { jsonrpc: '2.0', result: { status: 'success' }, id: 2 });

            await client.ping();
            await client.ping();
            expect(ids[1]).to.be.greaterThan(ids[0]);
        });
    });
});
