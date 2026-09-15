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

    describe('health', function () {
        it('calls the health RPC and returns tracker status fields', async function () {
            nock(BASE)
                .post('/', (body) => {
                    expect(body.jsonrpc).to.equal('2.0');
                    expect(body.method).to.equal('health');
                    return true;
                })
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { tracker_reachable: true, tracker_synced: true, tracker_lag: 0 },
                    id: 1
                });

            let result = await client.health();
            expect(result.tracker_reachable).to.equal(true);
            expect(result.tracker_synced).to.equal(true);
            expect(result.tracker_lag).to.equal(0);
        });

        it('returns unreachable state when tracker is down', async function () {
            nock(BASE)
                .post('/', (body) => body.method === 'health')
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { tracker_reachable: false, tracker_synced: false, tracker_lag: null },
                    id: 1
                });

            let result = await client.health();
            expect(result.tracker_reachable).to.equal(false);
            expect(result.tracker_lag).to.equal(null);
        });
    });
});
