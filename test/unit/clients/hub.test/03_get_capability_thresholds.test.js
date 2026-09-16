// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const nock = require('nock');
const HubConnector = require('../../../../src/clients/hub.js');

const HUB_BASE = 'http://localhost:10000';
const HUB2_BASE = 'http://hub2.test:8001';

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    /*
     *  getCapabilityThresholds()
     */

    describe('getCapabilityThresholds()', function () {
        const THRESHOLDS = [
            { capability: 'price', min_stake: '1000', disabled: false },
            { capability: 'cross_chain', min_stake: '5000', disabled: false }
        ];

        it('returns the thresholds array when the hub responds', async function () {
            nock(HUB_BASE)
                .post('/', body => body.method === 'getcapabilitythresholds')
                .reply(200, { jsonrpc: '2.0', result: { thresholds: THRESHOLDS }, id: 1 });

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.deepStrictEqual(rows, THRESHOLDS);
        });

        it('returns null when all endpoints fail', async function () {
            nock(HUB_BASE).post('/').replyWithError('connection refused');

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.strictEqual(rows, null);
        });

        it('returns null when result lacks a thresholds array', async function () {
            nock(HUB_BASE).post('/').reply(200, { jsonrpc: '2.0', result: { error: 'nope' }, id: 1 });

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.strictEqual(rows, null);
        });

        it('tries next endpoint on failure (multi-endpoint)', async function () {
            nock(HUB_BASE).post('/').replyWithError('timeout');
            nock(HUB2_BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { thresholds: THRESHOLDS }, id: 1 });

            let hub = new HubConnector({
                hubValidators: ['http://localhost:8001', 'http://hub2.test:8001']
            });
            let rows = await hub.getCapabilityThresholds();
            assert.deepStrictEqual(rows, THRESHOLDS);
            assert.strictEqual(hub._lastGoodIdx, 1);
        });
    });
});
